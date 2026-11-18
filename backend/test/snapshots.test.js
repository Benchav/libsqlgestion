const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-snapshots-test-'));
const testDbPath = path.join(tempDir, 'control.db');
const storageRoot = path.join(tempDir, 'storage');
const snapshotRoot = path.join(tempDir, 'snapshots');

process.env.DATABASE_FILE = testDbPath;
process.env.SQLITE_STORAGE_ROOT = storageRoot;
process.env.SNAPSHOT_STORAGE_ROOT = snapshotRoot;
process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.LIBSQL_ADMIN_URL = '';
process.env.LIBSQL_ENABLE_NAMESPACES = 'false';
process.env.LIBSQL_NAMESPACE_IMPORTS = 'false';
process.env.LIBSQL_IMPORT_RUNTIME = 'false';
process.env.DOCKER_SOCKET_PATH = path.join(tempDir, 'no-docker.sock');
process.env.SNAPSHOTS_ENABLED = 'true';
process.env.SNAPSHOT_INTERVAL_MINUTES = '60';
process.env.SNAPSHOT_RETENTION_DAYS = '14';
process.env.SNAPSHOT_MIN_FREE_BYTES = '1048576';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { SnapshotService } = require('../dist/application/snapshots/SnapshotService');
const { SnapshotScheduler } = require('../dist/application/snapshots/SnapshotScheduler');
const { SnapshotPolicyService } = require('../dist/application/snapshots/SnapshotPolicyService');
const { getDueMilestones, getPeriodKeys } = require('../dist/application/snapshots/snapshot-schedule');
const { DiscoveryService } = require('../dist/application/databases/DiscoveryService');
const { Project } = require('../dist/domain/entities/Project');
const { Database } = require('../dist/domain/entities/Database');
const { DatabaseSnapshot } = require('../dist/domain/entities/DatabaseSnapshot');
const { User } = require('../dist/domain/entities/User');
const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
const { buildServer } = require('../dist/server');

test.describe('Snapshots and restore points', () => {
  let snapshotService;
  let sourceProject;
  let sourceDatabase;
  let sourcePath;
  let app;
  let cookieHeader;
  let csrfToken;
  let apiDatabaseId;

  test.before(async () => {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();

    snapshotService = new SnapshotService();

    const userRepo = AppDataSource.getRepository(User);
    const owner = await userRepo.save(userRepo.create({
      email: 'snapshots-owner@example.com',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$abcde/fghijk$xyz',
    }));

    const projectRepo = AppDataSource.getRepository(Project);
    sourceProject = await projectRepo.save(projectRepo.create({
      name: 'Snapshots Project',
      owner,
    }));

    const sourceDir = path.join(storageRoot, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    sourcePath = path.join(sourceDir, 'source.db');

    const client = new SqliteClient(sourcePath);
    await client.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO items (name) VALUES ('before-snapshot');
    `);
    await client.close();

    const databaseRepo = AppDataSource.getRepository(Database);
    sourceDatabase = await databaseRepo.save(databaseRepo.create({
      name: 'source-database',
      type: 'sqlite',
      status: 'active',
      url: sourcePath,
      subdomain: 'source-database',
      project: sourceProject,
    }));

    app = buildServer();
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'snapshots-api@example.com', password: 'Snapshots123!' },
    });
    assert.equal(regRes.statusCode, 200);

    const cookies = {};
    const setCookies = regRes.headers['set-cookie'];
    for (const item of Array.isArray(setCookies) ? setCookies : [setCookies]) {
      const parts = item.split(';')[0].split('=');
      if (parts.length === 2) cookies[parts[0].trim()] = parts[1].trim();
    }
    csrfToken = cookies['libsqlite.csrfToken.v2'] || cookies['libsqlite.csrfToken'];
    cookieHeader = `libsqlite.accessToken=${cookies['libsqlite.accessToken']}; libsqlite.csrfToken.v2=${csrfToken}`;

    const fixtureDir = path.join(tempDir, 'fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixturePath = path.join(fixtureDir, 'api-source.db');
    const fixture = new SqliteClient(fixturePath);
    await fixture.exec(`
      CREATE TABLE api_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO api_items (name) VALUES ('api-before-snapshot');
    `);
    await fixture.close();

    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: { name: 'Snapshots API Project' },
    });
    assert.equal(projectRes.statusCode, 201);
    const apiProjectId = JSON.parse(projectRes.payload).project.id;

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/import-sqlite',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: { projectId: apiProjectId, name: 'api-snapshots-db', sourcePath: fixturePath },
    });
    assert.equal(importRes.statusCode, 201, importRes.payload);
    apiDatabaseId = JSON.parse(importRes.payload).database.id;
  });

  test.after(async () => {
    if (app) await app.close();
    await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates a consistent snapshot and records its checksum', async () => {
    const snapshot = await snapshotService.createSnapshot(sourceDatabase.id, {
      reason: 'manual',
      pinned: true,
    });

    assert.equal(snapshot.status, 'ready');
    assert.ok(snapshot.sizeBytes > 0);
    assert.match(snapshot.checksumSha256, /^[a-f0-9]{64}$/);
    assert.ok(fs.existsSync(snapshot.filePath));

    const list = await snapshotService.listSnapshots(sourceDatabase.id);
    assert.ok(list.snapshots.some((item) => item.id === snapshot.id));
    assert.ok(list.totalSizeBytes >= snapshot.sizeBytes);
    assert.equal(list.policy.intervalMinutes, 60);
  });

  test('restores a snapshot into a new database without changing the source', async () => {
    const snapshots = await snapshotService.listSnapshots(sourceDatabase.id);
    const snapshot = snapshots.snapshots.find((item) => item.status === 'ready');
    assert.ok(snapshot);

    const writer = new SqliteClient(sourcePath);
    await writer.run("INSERT INTO items (name) VALUES ('after-snapshot')");
    await writer.close();

    const restored = await snapshotService.restoreSnapshot(sourceDatabase.id, snapshot.id, {
      name: 'restored-database',
    });

    assert.equal(restored.database.status, 'active');
    assert.ok(restored.token);
    assert.ok(restored.database.url && fs.existsSync(restored.database.url));
    assert.notEqual(restored.database.url, sourcePath);

    const restoredClient = new SqliteClient(restored.database.url);
    const restoredRows = await restoredClient.all('SELECT name FROM items ORDER BY id');
    await restoredClient.close();

    const sourceClient = new SqliteClient(sourcePath);
    const sourceRows = await sourceClient.all('SELECT name FROM items ORDER BY id');
    await sourceClient.close();

    assert.deepEqual(restoredRows.map((row) => row.name), ['before-snapshot']);
    assert.deepEqual(sourceRows.map((row) => row.name), ['before-snapshot', 'after-snapshot']);
  });

  test('creates a snapshot from a live WAL database', async () => {
    const writer = new SqliteClient(sourcePath);
    await writer.run("INSERT INTO items (name) VALUES ('live-wal')");

    const snapshot = await snapshotService.createSnapshot(sourceDatabase.id, {
      reason: 'manual',
      pinned: true,
    });
    await writer.close();

    const snapshotClient = new SqliteClient(snapshot.filePath);
    const rows = await snapshotClient.all("SELECT name FROM items WHERE name = 'live-wal'");
    await snapshotClient.close();

    assert.equal(rows.length, 1);
  });

  test('applies tiered retention and preserves pinned snapshots', async () => {
    const databaseRepo = AppDataSource.getRepository(Database);
    const retentionPath = path.join(tempDir, 'retention.db');
    const retentionFile = new SqliteClient(retentionPath);
    await retentionFile.exec('CREATE TABLE retention_items (id INTEGER PRIMARY KEY);');
    await retentionFile.close();

    const retentionDb = await databaseRepo.save(databaseRepo.create({
      name: 'retention-database',
      type: 'sqlite',
      status: 'active',
      url: retentionPath,
      subdomain: 'retention-database',
      project: sourceProject,
    }));

    const snapshotRepo = AppDataSource.getRepository(DatabaseSnapshot);
    const now = new Date('2026-01-15T12:00:00.000Z');
    const ages = [
      { hours: 1, pinned: false },
      { hours: 6, pinned: false },
      { hours: 25, pinned: false },
      { hours: 26, pinned: false },
      { hours: 49, pinned: false },
      { hours: 96, pinned: false },
      { hours: 240, pinned: false },
      { hours: 480, pinned: false },
      { hours: 480, pinned: true },
    ];

    const directory = path.join(snapshotRoot, sourceProject.id, retentionDb.id);
    fs.mkdirSync(directory, { recursive: true });

    for (const [index, age] of ages.entries()) {
      const fileName = `retention-${index}.db`;
      const filePath = path.join(directory, fileName);
      fs.writeFileSync(filePath, 'snapshot');
      await snapshotRepo.save(snapshotRepo.create({
        databaseId: retentionDb.id,
        projectId: sourceProject.id,
        status: 'ready',
        reason: 'scheduled',
        filePath,
        fileName,
        sizeBytes: 8,
        takenAt: new Date(now.getTime() - age.hours * 60 * 60 * 1000),
        pinned: age.pinned,
      }));
    }

    const result = await snapshotService.pruneSnapshots(retentionDb.id, now);
    assert.equal(result.deleted, 2);

    const remaining = await snapshotRepo.find({ where: { databaseId: retentionDb.id } });
    assert.equal(remaining.filter((item) => item.status === 'ready').length, 7);
    assert.equal(remaining.filter((item) => item.status === 'deleted').length, 2);
    assert.ok(remaining.some((item) => item.pinned && item.status === 'ready'));
  });

  test('stores per-database backup policy and validates timezones', async () => {
    const policyService = new SnapshotPolicyService();
    const defaults = await policyService.getPolicy(sourceDatabase.id);
    assert.equal(defaults.isDefault, true);
    assert.equal(defaults.restorePointIntervalMinutes, 60);
    assert.equal(defaults.dailyEnabled, true);

    const saved = await policyService.upsertPolicy(sourceDatabase.id, {
      restorePointIntervalMinutes: 30,
      dailyEnabled: true,
      dailyRetention: 7,
      weeklyEnabled: true,
      weeklyDayOfWeek: 1,
      weeklyAtHour: 3,
      weeklyRetention: 4,
      monthlyEnabled: true,
      monthlyDayOfMonth: 5,
      monthlyAtHour: 4,
      monthlyRetention: 6,
      timezone: 'UTC',
    });

    assert.equal(saved.isDefault, false);
    assert.equal(saved.restorePointIntervalMinutes, 30);
    assert.equal(saved.weeklyDayOfWeek, 1);
    assert.equal(saved.monthlyRetention, 6);

    await assert.rejects(
      policyService.upsertPolicy(sourceDatabase.id, { timezone: 'Not/A_Timezone' }),
      /invalid timezone/,
    );
  });

  test('calculates daily, weekly and monthly milestone boundaries', () => {
    const policy = {
      databaseId: sourceDatabase.id,
      restorePointIntervalMinutes: 60,
      dailyEnabled: true,
      dailyAtHour: 2,
      dailyRetention: 14,
      weeklyEnabled: true,
      weeklyDayOfWeek: 1,
      weeklyAtHour: 3,
      weeklyRetention: 8,
      monthlyEnabled: true,
      monthlyDayOfMonth: 1,
      monthlyAtHour: 2,
      monthlyRetention: 12,
      timezone: 'UTC',
      isDefault: false,
    };

    const wednesday = new Date('2026-11-18T04:00:00.000Z');
    const due = getDueMilestones(wednesday, policy, []);
    assert.deepEqual(due.map((item) => item.type), ['daily', 'weekly', 'monthly']);

    const { dailyKey, weeklyKey, monthlyKey } = getPeriodKeys(wednesday, 'UTC');
    const tagged = [{
      metadata: { milestones: { daily: dailyKey, weekly: weeklyKey, monthly: monthlyKey } },
    }];
    assert.deepEqual(getDueMilestones(wednesday, policy, tagged), []);

    const sundayPolicy = { ...policy, weeklyDayOfWeek: 0 };
    assert.ok(!getDueMilestones(wednesday, sundayPolicy, []).some((item) => item.type === 'weekly'));
    assert.ok(getDueMilestones(new Date('2026-11-22T03:00:00.000Z'), sundayPolicy, [])
      .some((item) => item.type === 'weekly'));
  });

  test('keeps long-term milestone snapshots outside the tiered window', async () => {
    const databaseRepo = AppDataSource.getRepository(Database);
    const snapshotRepo = AppDataSource.getRepository(DatabaseSnapshot);
    const milestonePath = path.join(tempDir, 'milestone.db');
    const milestoneFile = new SqliteClient(milestonePath);
    await milestoneFile.exec('CREATE TABLE milestone_items (id INTEGER PRIMARY KEY);');
    await milestoneFile.close();

    const policyDb = await databaseRepo.save(databaseRepo.create({
      name: 'milestone-database',
      type: 'sqlite',
      status: 'active',
      url: milestonePath,
      subdomain: 'milestone-database',
      project: sourceProject,
    }));

    const directory = path.join(snapshotRoot, sourceProject.id, policyDb.id);
    fs.mkdirSync(directory, { recursive: true });
    const now = new Date('2026-01-15T12:00:00.000Z');
    const ages = [20, 30, 40, 50];
    const rows = [];

    for (const [index, days] of ages.entries()) {
      const fileName = `milestone-${index}.db`;
      const filePath = path.join(directory, fileName);
      fs.writeFileSync(filePath, 'snapshot');
      rows.push(await snapshotRepo.save(snapshotRepo.create({
        databaseId: policyDb.id,
        projectId: sourceProject.id,
        status: 'ready',
        reason: 'scheduled',
        filePath,
        fileName,
        sizeBytes: 8,
        takenAt: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
        metadata: days === 40 ? { milestones: { daily: '2025-12-06' } } : undefined,
      })));
    }

    const policyService = new SnapshotPolicyService();
    const policy = await policyService.upsertPolicy(policyDb.id, {
      dailyEnabled: true,
      dailyRetention: 1,
      weeklyEnabled: false,
      monthlyEnabled: false,
      timezone: 'UTC',
    });

    await snapshotService.pruneSnapshots(policyDb.id, now, policy);

    const updated = await snapshotRepo.find({ where: { databaseId: policyDb.id } });
    const byId = new Map(updated.map((row) => [row.id, row]));
    assert.equal(byId.get(rows[2].id).status, 'ready');
    assert.equal(byId.get(rows[3].id).status, 'deleted');
  });

  test('discovery ignores managed and snapshot directories', () => {
    const root = path.join(tempDir, 'discovery-root');
    fs.mkdirSync(path.join(root, 'projects', 'p1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'snapshots', 'p1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'raw.db'), '');
    fs.writeFileSync(path.join(root, 'projects', 'p1', 'managed.db'), '');
    fs.writeFileSync(path.join(root, 'snapshots', 'p1', 'restore.db'), '');

    const discovery = new DiscoveryService();
    const files = discovery.collectSqliteFiles(root);

    assert.deepEqual(files, [path.join(root, 'raw.db')]);
  });

  test('startup recovery marks interrupted pending snapshots as failed', async () => {
    const snapshotRepo = AppDataSource.getRepository(DatabaseSnapshot);
    const directory = path.join(snapshotRoot, sourceProject.id, sourceDatabase.id);
    fs.mkdirSync(directory, { recursive: true });

    const row = await snapshotRepo.save(snapshotRepo.create({
      databaseId: sourceDatabase.id,
      projectId: sourceProject.id,
      status: 'pending',
      reason: 'scheduled',
      filePath: path.join(directory, 'interrupted.db'),
      fileName: 'interrupted.db',
      sizeBytes: 0,
      takenAt: new Date(),
    }));
    const tempPath = path.join(directory, `.tmp-${row.id}.db`);
    fs.writeFileSync(tempPath, 'temp');
    fs.writeFileSync(row.filePath, 'partial');

    await snapshotService.recoverInterruptedSnapshots();

    const updated = await snapshotRepo.findOneBy({ id: row.id });
    assert.equal(updated.status, 'failed');
    assert.match(updated.errorMessage, /restart/);
    assert.equal(fs.existsSync(tempPath), false);
    assert.equal(fs.existsSync(row.filePath), false);
  });

  test('scheduler creates an initial snapshot for a database without one', async () => {
    const scheduler = new SnapshotScheduler(snapshotService);
    const result = await scheduler.runOnce(new Date());
    assert.ok(result.created >= 1);

    const state = await snapshotService.getSchedulerState(sourceDatabase.id);
    assert.ok(state.latest);
    assert.equal(state.pending, false);
  });

  test('HTTP API lists, restores and downloads snapshots', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${apiDatabaseId}/snapshots`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
    });
    assert.equal(createRes.statusCode, 201, createRes.payload);
    const created = JSON.parse(createRes.payload).snapshot;
    assert.equal(created.status, 'ready');
    assert.equal(created.reason, 'manual');

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${apiDatabaseId}/snapshots`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(listRes.statusCode, 200);
    const list = JSON.parse(listRes.payload);
    assert.ok(list.snapshots.some((item) => item.id === created.id));
    assert.deepEqual(list.snapshots.find((item) => item.id === created.id).milestones, {});

    const futureRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${apiDatabaseId}/snapshots?before=2099-01-01T00:00:00.000Z`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(futureRes.statusCode, 200);
    assert.ok(JSON.parse(futureRes.payload).snapshots.some((item) => item.id === created.id));

    const pastRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${apiDatabaseId}/snapshots?before=2000-01-01T00:00:00.000Z`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(pastRes.statusCode, 200);
    assert.equal(JSON.parse(pastRes.payload).snapshots.length, 0);

    const projectsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: cookieHeader },
    });
    assert.equal(projectsRes.statusCode, 200);
    const apiProject = JSON.parse(projectsRes.payload).projects.find((project) => project.name === 'Snapshots API Project');
    assert.ok(apiProject);
    assert.equal(apiProject.databaseCount, 1);

    const policyRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${apiDatabaseId}/snapshot-policy`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(policyRes.statusCode, 200);
    assert.equal(JSON.parse(policyRes.payload).policy.isDefault, true);

    const updatePolicyRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/databases/${apiDatabaseId}/snapshot-policy`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: {
        restorePointIntervalMinutes: 30,
        dailyEnabled: true,
        dailyRetention: 3,
        weeklyEnabled: true,
        weeklyDayOfWeek: 1,
        monthlyEnabled: false,
        timezone: 'UTC',
      },
    });
    assert.equal(updatePolicyRes.statusCode, 200, updatePolicyRes.payload);
    const updatedPolicy = JSON.parse(updatePolicyRes.payload).policy;
    assert.equal(updatedPolicy.restorePointIntervalMinutes, 30);
    assert.equal(updatedPolicy.dailyRetention, 3);
    assert.equal(updatedPolicy.weeklyEnabled, true);

    const restoreRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${apiDatabaseId}/snapshots/${created.id}/restore`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: { name: 'api-restored-db' },
    });
    assert.equal(restoreRes.statusCode, 201, restoreRes.payload);
    const restored = JSON.parse(restoreRes.payload);
    assert.ok(restored.token);
    assert.equal(restored.database.name, 'api-restored-db');
    assert.ok(fs.existsSync(restored.database.url));

    const downloadRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${apiDatabaseId}/snapshots/${created.id}/download`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(downloadRes.statusCode, 200);
    assert.ok(downloadRes.headers['content-disposition'].includes('.db'));
    assert.ok(downloadRes.rawPayload.length > 0);
  });
});

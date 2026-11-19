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
const {
  getSnapshotArtifacts,
  getSnapshotFormat,
} = require('../dist/application/snapshots/SnapshotService');
const libsqlDumpModule = require('../dist/application/snapshots/libsql-dump');
const libsqlClientModule = require('../dist/infrastructure/libsql/LibsqlClient');
const { encrypt } = require('../dist/infrastructure/crypto');

const LIBSQL_TEST_DUMP = `BEGIN TRANSACTION;
CREATE TABLE libsql_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO libsql_items (id, name) VALUES (1, 'alpha');
INSERT INTO libsql_items (id, name) VALUES (2, 'beta');
COMMIT;
`;

function installLibsqlStubs() {
  const originalFetch = libsqlDumpModule.fetchLibsqlDump;
  const originalReplay = libsqlDumpModule.replaySqlDumpToSqlite;
  const originalCreateClient = libsqlClientModule.createLibsqlClient;

  libsqlDumpModule.fetchLibsqlDump = async (_database, _token, destinationPath) => {
    fs.writeFileSync(destinationPath, LIBSQL_TEST_DUMP);
    return { bytes: Buffer.byteLength(LIBSQL_TEST_DUMP), url: 'stub://dump' };
  };
  libsqlClientModule.createLibsqlClient = () => ({
    batch: async () => [
      { rows: [{ user_version: 11 }] },
      { rows: [{ application_id: 4242 }] },
      { rows: [{ page_size: 4096 }] },
      { rows: [{ encoding: 'UTF-8' }] },
      { rows: [{ auto_vacuum: 1 }] },
    ],
    execute: async () => ({ rows: [] }),
    close() {},
  });

  return {
    failReplay() {
      libsqlDumpModule.replaySqlDumpToSqlite = async () => {
        throw new Error('simulated replay failure');
      };
    },
    restore() {
      libsqlDumpModule.fetchLibsqlDump = originalFetch;
      libsqlDumpModule.replaySqlDumpToSqlite = originalReplay;
      libsqlClientModule.createLibsqlClient = originalCreateClient;
    },
  };
}

test.describe('Snapshot artifact metadata', () => {
  test('keeps legacy .sql snapshots compatible', () => {
    const snapshot = {
      filePath: path.join(tempDir, 'legacy.sql'),
      fileName: 'legacy.sql',
      sizeBytes: 128,
      checksumSha256: 'a'.repeat(64),
      metadata: { format: 'libsql-sql-dump', verified: true },
    };

    const artifacts = getSnapshotArtifacts(snapshot);
    assert.equal(getSnapshotFormat(snapshot), 'libsql-sql-dump');
    assert.equal(artifacts.primary.kind, 'sql');
    assert.equal(artifacts.preferred.kind, 'sql');
    assert.deepEqual(artifacts.downloadFormats, ['sql']);
    assert.equal(artifacts.totalBytes, 128);
  });

  test('describes a transitional both-mode snapshot with two artifacts', () => {
    const snapshot = {
      filePath: path.join(tempDir, 'both.sql'),
      fileName: 'both.sql',
      sizeBytes: 128,
      checksumSha256: 'b'.repeat(64),
      metadata: {
        format: 'libsql-sqlite-export',
        verified: true,
        sqliteFileName: 'both.db',
        sqliteSizeBytes: 256,
        sqliteChecksumSha256: 'c'.repeat(64),
        dumpFileName: 'both.sql',
        dumpSizeBytes: 128,
        totalBytes: 384,
      },
    };

    const artifacts = getSnapshotArtifacts(snapshot);
    assert.equal(getSnapshotFormat(snapshot), 'libsql-sqlite-export');
    assert.equal(artifacts.preferred.kind, 'db');
    assert.equal(artifacts.db.sizeBytes, 256);
    assert.deepEqual(artifacts.downloadFormats, ['db', 'sql']);
    assert.equal(artifacts.totalBytes, 384);
  });

  test('exposes the fallback warning instead of hiding a materialization failure', () => {
    const snapshot = {
      filePath: path.join(tempDir, 'fallback.sql'),
      fileName: 'fallback.sql',
      sizeBytes: 64,
      checksumSha256: 'd'.repeat(64),
      metadata: {
        format: 'libsql-sql-dump',
        verified: false,
        warning: 'SQLite export could not be materialized',
      },
    };

    const artifacts = getSnapshotArtifacts(snapshot);
    assert.equal(artifacts.preferred.kind, 'sql');
    assert.match(artifacts.warning, /could not be materialized/);
    assert.equal(getSnapshotFormat(snapshot), 'libsql-sql-dump');
  });
});

test.describe('Snapshots and restore points', () => {
  let snapshotService;
  let sourceProject;
  let sourceDatabase;
  let sourcePath;
  let app;
  let cookieHeader;
  let csrfToken;
  let apiDatabaseId;

  async function createLibsqlDatabase(name) {
    const databaseRepo = AppDataSource.getRepository(Database);
    const endpoint = 'http://127.0.0.1:65535';
    return databaseRepo.save(databaseRepo.create({
      name,
      type: 'libsql',
      status: 'active',
      url: endpoint,
      subdomain: name,
      encryptedToken: encrypt('test-libsql-token'),
      metadata: {
        runtime: {
          provider: 'docker-libsql',
          connectionUrl: endpoint,
          internalUrl: endpoint,
          backendUrl: endpoint,
          publicUrl: endpoint,
        },
      },
      project: sourceProject,
    }));
  }

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
    const tempSqlPath = path.join(directory, `.tmp-${row.id}.sql`);
    const sqlSibling = row.filePath.replace(/\.db$/i, '.sql');
    fs.writeFileSync(tempPath, 'temp');
    fs.writeFileSync(tempSqlPath, 'temp');
    fs.writeFileSync(row.filePath, 'partial');
    fs.writeFileSync(sqlSibling, 'partial');

    await snapshotService.recoverInterruptedSnapshots();

    const updated = await snapshotRepo.findOneBy({ id: row.id });
    assert.equal(updated.status, 'failed');
    assert.match(updated.errorMessage, /restart/);
    assert.equal(fs.existsSync(tempPath), false);
    assert.equal(fs.existsSync(tempSqlPath), false);
    assert.equal(fs.existsSync(row.filePath), false);
    assert.equal(fs.existsSync(sqlSibling), false);
  });

  test('rejects a restore when the stored checksum no longer matches', async () => {
    const snapshot = await snapshotService.createSnapshot(sourceDatabase.id, {
      reason: 'manual',
      pinned: true,
    });

    fs.appendFileSync(snapshot.filePath, Buffer.from('tampered'));

    await assert.rejects(
      snapshotService.restoreSnapshot(sourceDatabase.id, snapshot.id, {
        name: 'checksum-restore-must-fail',
      }),
      /checksum verification failed/,
    );

    await snapshotService.deleteSnapshot(sourceDatabase.id, snapshot.id);
  });

  test('prune removes every artifact of a transitional snapshot', async () => {
    const databaseRepo = AppDataSource.getRepository(Database);
    const snapshotRepo = AppDataSource.getRepository(DatabaseSnapshot);
    const prunePath = path.join(tempDir, 'prune-source.db');
    const pruneSource = new SqliteClient(prunePath);
    await pruneSource.exec('CREATE TABLE prune_items (id INTEGER PRIMARY KEY);');
    await pruneSource.close();

    const pruneDb = await databaseRepo.save(databaseRepo.create({
      name: 'prune-both-database',
      type: 'sqlite',
      status: 'active',
      url: prunePath,
      subdomain: 'prune-both-database',
      project: sourceProject,
    }));

    const directory = path.join(snapshotRoot, sourceProject.id, pruneDb.id);
    fs.mkdirSync(directory, { recursive: true });
    const now = new Date('2026-01-15T12:00:00.000Z');
    const ages = [1, 2, 30 * 24];
    const rows = [];

    for (const [index, hours] of ages.entries()) {
      const dumpFileName = `transitional-${index}.sql`;
      const sqliteFileName = `transitional-${index}.db`;
      const filePath = path.join(directory, dumpFileName);
      fs.writeFileSync(filePath, 'dump');
      fs.writeFileSync(path.join(directory, sqliteFileName), 'database');
      rows.push(await snapshotRepo.save(snapshotRepo.create({
        databaseId: pruneDb.id,
        projectId: sourceProject.id,
        status: 'ready',
        reason: 'scheduled',
        filePath,
        fileName: dumpFileName,
        sizeBytes: 4,
        takenAt: new Date(now.getTime() - hours * 60 * 60 * 1000),
        metadata: {
          format: 'libsql-sqlite-export',
          sqliteFileName,
          sqliteSizeBytes: 8,
          dumpFileName,
          dumpSizeBytes: 4,
          totalBytes: 12,
        },
      })));
    }

    const result = await snapshotService.pruneSnapshots(pruneDb.id, now);
    assert.equal(result.deleted, 1);

    const oldest = rows[2];
    assert.equal(fs.existsSync(oldest.filePath), false);
    assert.equal(fs.existsSync(path.join(directory, `transitional-2.db`)), false);
    assert.equal(fs.existsSync(rows[0].filePath), true);
    assert.equal(fs.existsSync(path.join(directory, `transitional-0.db`)), true);

    await databaseRepo.remove(pruneDb);
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
    assert.equal(downloadRes.headers['x-backup-artifact'], 'db');
    assert.equal(Number(downloadRes.headers['content-length']), downloadRes.rawPayload.length);
    assert.ok(downloadRes.rawPayload.length > 0);

    const sqlDownloadRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${apiDatabaseId}/snapshots/${created.id}/download?format=sql`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(sqlDownloadRes.statusCode, 409, sqlDownloadRes.payload);

    const sqlRestoreRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${apiDatabaseId}/snapshots/${created.id}/restore`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: { name: 'api-restore-sql-not-available', artifactFormat: 'sql' },
    });
    assert.equal(sqlRestoreRes.statusCode, 409, sqlRestoreRes.payload);
  });

  test('creates a verified SQLite export for a managed libSQL primary', async () => {
    const stubs = installLibsqlStubs();
    const previousArtifact = process.env.SNAPSHOT_LIBSQL_ARTIFACT;
    process.env.SNAPSHOT_LIBSQL_ARTIFACT = 'sqlite';

    try {
      const database = await createLibsqlDatabase('libsql-sqlite-mode');
      const snapshot = await snapshotService.createSnapshot(database.id, {
        reason: 'manual',
        pinned: true,
      });

      assert.equal(snapshot.status, 'ready');
      assert.match(snapshot.fileName, /\.db$/);
      assert.equal(snapshot.metadata.format, 'libsql-sqlite-export');
      assert.equal(snapshot.metadata.verified, true);
      assert.equal(snapshot.metadata.sourcePragmas.userVersion, 11);
      assert.equal(snapshot.metadata.sourcePragmas.applicationId, 4242);

      const client = new SqliteClient(snapshot.filePath);
      try {
        const rows = await client.all('SELECT id, name FROM libsql_items ORDER BY id');
        assert.deepEqual(rows, [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }]);

        const userVersion = await client.get('PRAGMA user_version');
        const applicationId = await client.get('PRAGMA application_id');
        const autoVacuum = await client.get('PRAGMA auto_vacuum');
        assert.equal(Number(userVersion.user_version), 11);
        assert.equal(Number(applicationId.application_id), 4242);
        assert.equal(Number(autoVacuum.auto_vacuum), 1);
      } finally {
        await client.close();
      }

      const artifacts = getSnapshotArtifacts(snapshot);
      assert.deepEqual(artifacts.downloadFormats, ['db']);
      assert.equal(artifacts.totalBytes, snapshot.sizeBytes);

      const download = await snapshotService.resolveSnapshotDownload(database.id, snapshot.id);
      assert.equal(download.artifact.kind, 'db');
      assert.equal(download.artifact.path, snapshot.filePath);
      await assert.rejects(
        snapshotService.resolveSnapshotDownload(database.id, snapshot.id, 'sql'),
        /not retained/,
      );

      const artifactPath = snapshot.filePath;
      await snapshotService.deleteSnapshot(database.id, snapshot.id);
      assert.equal(fs.existsSync(artifactPath), false);
      await AppDataSource.getRepository(Database).remove(database);
    } finally {
      stubs.restore();
      if (previousArtifact === undefined) delete process.env.SNAPSHOT_LIBSQL_ARTIFACT;
      else process.env.SNAPSHOT_LIBSQL_ARTIFACT = previousArtifact;
    }
  });

  test('keeps both artifacts in transitional mode and restores from either one', async () => {
    const stubs = installLibsqlStubs();
    const previousArtifact = process.env.SNAPSHOT_LIBSQL_ARTIFACT;
    process.env.SNAPSHOT_LIBSQL_ARTIFACT = 'both';

    try {
      const database = await createLibsqlDatabase('libsql-both-mode');
      const snapshot = await snapshotService.createSnapshot(database.id, {
        reason: 'manual',
        pinned: true,
      });

      assert.equal(snapshot.status, 'ready');
      assert.match(snapshot.fileName, /\.sql$/);
      assert.equal(snapshot.metadata.format, 'libsql-sqlite-export');
      assert.equal(snapshot.metadata.dumpFileName, snapshot.fileName);
      assert.match(snapshot.metadata.sqliteFileName, /\.db$/);

      const dbPath = path.join(path.dirname(snapshot.filePath), snapshot.metadata.sqliteFileName);
      assert.equal(fs.existsSync(snapshot.filePath), true);
      assert.equal(fs.existsSync(dbPath), true);
      assert.ok(snapshot.sizeBytes > 0);
      assert.equal(snapshot.metadata.totalBytes, snapshot.sizeBytes + snapshot.metadata.sqliteSizeBytes);

      const artifacts = getSnapshotArtifacts(snapshot);
      assert.equal(getSnapshotFormat(snapshot), 'libsql-sqlite-export');
      assert.deepEqual(artifacts.downloadFormats, ['db', 'sql']);
      assert.equal(artifacts.totalBytes, snapshot.metadata.totalBytes);

      const defaultDownload = await snapshotService.resolveSnapshotDownload(database.id, snapshot.id);
      assert.equal(defaultDownload.artifact.kind, 'db');
      assert.equal(defaultDownload.artifact.path, dbPath);

      const sqlDownload = await snapshotService.resolveSnapshotDownload(database.id, snapshot.id, 'sql');
      assert.equal(sqlDownload.artifact.kind, 'sql');
      assert.equal(sqlDownload.artifact.path, snapshot.filePath);

      const restoredFromDb = await snapshotService.restoreSnapshot(database.id, snapshot.id, {
        name: 'libsql-restored-from-db',
      });
      assert.equal(restoredFromDb.database.metadata.snapshotArtifact, 'db');
      const dbClient = new SqliteClient(restoredFromDb.database.url);
      try {
        const rows = await dbClient.all('SELECT name FROM libsql_items ORDER BY id');
        assert.deepEqual(rows.map((row) => row.name), ['alpha', 'beta']);
      } finally {
        await dbClient.close();
      }

      const restoredFromSql = await snapshotService.restoreSnapshot(database.id, snapshot.id, {
        name: 'libsql-restored-from-sql',
        artifactFormat: 'sql',
      });
      assert.equal(restoredFromSql.database.metadata.snapshotArtifact, 'sql');
      const sqlClient = new SqliteClient(restoredFromSql.database.url);
      try {
        const rows = await sqlClient.all('SELECT name FROM libsql_items ORDER BY id');
        assert.deepEqual(rows.map((row) => row.name), ['alpha', 'beta']);
      } finally {
        await sqlClient.close();
      }

      const releaseLease = snapshotService.acquireSnapshotLease(snapshot.id);
      await assert.rejects(
        snapshotService.deleteSnapshot(database.id, snapshot.id),
        /running restore or download/,
      );
      releaseLease();

      await snapshotService.deleteSnapshot(database.id, snapshot.id);
      assert.equal(fs.existsSync(snapshot.filePath), false);
      assert.equal(fs.existsSync(dbPath), false);

      const databaseRepo = AppDataSource.getRepository(Database);
      await databaseRepo.remove(restoredFromDb.database);
      await databaseRepo.remove(restoredFromSql.database);
      await databaseRepo.remove(database);
    } finally {
      stubs.restore();
      if (previousArtifact === undefined) delete process.env.SNAPSHOT_LIBSQL_ARTIFACT;
      else process.env.SNAPSHOT_LIBSQL_ARTIFACT = previousArtifact;
    }
  });

  test('retains legacy SQL-only snapshots in dump mode', async () => {
    const stubs = installLibsqlStubs();
    const previousArtifact = process.env.SNAPSHOT_LIBSQL_ARTIFACT;
    process.env.SNAPSHOT_LIBSQL_ARTIFACT = 'dump';

    try {
      const database = await createLibsqlDatabase('libsql-dump-mode');
      const snapshot = await snapshotService.createSnapshot(database.id, {
        reason: 'manual',
        pinned: true,
      });

      assert.equal(snapshot.status, 'ready');
      assert.match(snapshot.fileName, /\.sql$/);
      assert.equal(snapshot.metadata.format, 'libsql-sql-dump');
      assert.equal(snapshot.metadata.verified, true);

      const dbPath = snapshot.filePath.replace(/\.sql$/i, '.db');
      assert.equal(fs.existsSync(dbPath), false);

      const artifacts = getSnapshotArtifacts(snapshot);
      assert.deepEqual(artifacts.downloadFormats, ['sql']);
      const download = await snapshotService.resolveSnapshotDownload(database.id, snapshot.id);
      assert.equal(download.artifact.kind, 'sql');

      await snapshotService.deleteSnapshot(database.id, snapshot.id);
      assert.equal(fs.existsSync(snapshot.filePath), false);
      await AppDataSource.getRepository(Database).remove(database);
    } finally {
      stubs.restore();
      if (previousArtifact === undefined) delete process.env.SNAPSHOT_LIBSQL_ARTIFACT;
      else process.env.SNAPSHOT_LIBSQL_ARTIFACT = previousArtifact;
    }
  });

  test('falls back to the validated SQL dump when materialization fails', async () => {
    const stubs = installLibsqlStubs();
    const previousArtifact = process.env.SNAPSHOT_LIBSQL_ARTIFACT;
    process.env.SNAPSHOT_LIBSQL_ARTIFACT = 'sqlite';
    stubs.failReplay();

    try {
      const database = await createLibsqlDatabase('libsql-replay-fallback');
      const snapshot = await snapshotService.createSnapshot(database.id, {
        reason: 'manual',
        pinned: true,
      });

      assert.equal(snapshot.status, 'ready');
      assert.match(snapshot.fileName, /\.sql$/);
      assert.equal(snapshot.metadata.format, 'libsql-sql-dump');
      assert.equal(snapshot.metadata.verified, false);
      assert.match(snapshot.metadata.warning, /SQLite export could not be materialized/);
      assert.equal(fs.existsSync(snapshot.filePath), true);
      assert.equal(fs.existsSync(snapshot.filePath.replace(/\.sql$/i, '.db')), false);

      const artifacts = getSnapshotArtifacts(snapshot);
      assert.equal(artifacts.preferred.kind, 'sql');
      assert.deepEqual(artifacts.downloadFormats, ['sql']);
      assert.match(artifacts.warning, /simulated replay failure/);

      await snapshotService.deleteSnapshot(database.id, snapshot.id);
      await AppDataSource.getRepository(Database).remove(database);
    } finally {
      stubs.restore();
      if (previousArtifact === undefined) delete process.env.SNAPSHOT_LIBSQL_ARTIFACT;
      else process.env.SNAPSHOT_LIBSQL_ARTIFACT = previousArtifact;
    }
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Set up isolated environment variables BEFORE loading the data-source
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-backup-test-'));
const testDbPath = path.join(tempDir, 'control.db');
const storageRoot = path.join(tempDir, 'storage');

process.env.DATABASE_FILE = testDbPath;
process.env.SQLITE_STORAGE_ROOT = storageRoot;
process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { DatabaseService } = require('../dist/application/databases/DatabaseService');
const { Project } = require('../dist/domain/entities/Project');
const { Database } = require('../dist/domain/entities/Database');
const { User } = require('../dist/domain/entities/User');
const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
const { buildServer } = require('../dist/server');

test.describe('Database Backup Full Flow Integration', () => {
  let databaseService;
  let testUser;
  let testProject;
  let testDb;
  let sourceSqlitePath;

  let app;
  let cookieHeader;
  let csrfToken;
  let apiProjectId;
  let apiDbId;

  test.before(async () => {
    // 1. Initialize isolated AppDataSource & migrations
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();

    databaseService = new DatabaseService();

    // 2. Setup service-level test data (mock User, Project, Database, and physical file)
    const userRepo = AppDataSource.getRepository(User);
    testUser = await userRepo.save(
      userRepo.create({
        email: 'service-owner@example.com',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$abcde/fghijk$xyz',
      })
    );

    const projectRepo = AppDataSource.getRepository(Project);
    testProject = await projectRepo.save(
      projectRepo.create({
        name: 'Service Test Project',
        description: 'Testing backup flow in service',
        owner: testUser,
      })
    );

    const sourceDbDir = path.join(storageRoot, 'source-dbs');
    fs.mkdirSync(sourceDbDir, { recursive: true });
    sourceSqlitePath = path.join(sourceDbDir, 'original.db');

    const sqliteClient = new SqliteClient(sourceSqlitePath);
    await sqliteClient.exec(`
      CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO test_table (name) VALUES ('original_data');
    `);
    sqliteClient.close();

    const dbRepo = AppDataSource.getRepository(Database);
    testDb = await dbRepo.save(
      dbRepo.create({
        name: 'service-original-db',
        type: 'sqlite',
        status: 'active',
        url: sourceSqlitePath,
        subdomain: 'service-original-subdomain',
        project: testProject,
      })
    );

    // 3. Boot the Fastify server for HTTP API testing
    app = buildServer();

    // 4. Register a user via API to establish authentication session cookies
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'api-admin@example.com', password: 'Password123!' }
    });
    assert.equal(regRes.statusCode, 200);

    // Extract auth cookies & CSRF tokens
    const setCookies = regRes.headers['set-cookie'];
    const cookies = {};
    const list = Array.isArray(setCookies) ? setCookies : [setCookies];
    for (const item of list) {
      const parts = item.split(';')[0].split('=');
      if (parts.length === 2) {
        cookies[parts[0].trim()] = parts[1].trim();
      }
    }

    csrfToken = cookies['libsqlite.csrfToken.v2'] || cookies['libsqlite.csrfToken'];
    cookieHeader = `libsqlite.accessToken=${cookies['libsqlite.accessToken']}; libsqlite.csrfToken.v2=${csrfToken}`;

    // 5. Create a project via API
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: {
        cookie: cookieHeader,
        'x-csrf-token-v2': csrfToken
      },
      payload: { name: 'API Backup Project' }
    });
    assert.equal(projRes.statusCode, 201);
    const projData = JSON.parse(projRes.payload);
    apiProjectId = projData.project.id;

    // 6. Create a database via API (this automatically writes an empty sqlite file to disk)
    const dbRes = await app.inject({
      method: 'POST',
      url: '/api/v1/databases',
      headers: {
        cookie: cookieHeader,
        'x-csrf-token-v2': csrfToken
      },
      payload: { projectId: apiProjectId, name: 'api-original-db', type: 'sqlite' }
    });
    assert.equal(dbRes.statusCode, 201);
    const dbData = JSON.parse(dbRes.payload);
    apiDbId = dbData.database.id;
  });

  test.after(async () => {
    if (app) await app.close();
    await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ==========================================
  // Service-Level Tests
  // ==========================================
  test.describe('Service-Level Backup Logic', () => {
    test('successfully backs up a database and copies its contents', async () => {
      const backupName = 'backup-db-copy';
      const result = await databaseService.backupDatabase(testDb.id, { name: backupName });

      // Verify return structure
      assert.ok(result.database);
      assert.ok(result.token);
      assert.equal(result.database.name, backupName);
      assert.equal(result.database.type, 'sqlite');
      assert.equal(result.database.status, 'active');

      // Verify metadata properties are correctly appended/created
      assert.equal(result.database.metadata.backup, true);
      assert.equal(result.database.metadata.sourceId, testDb.id);
      assert.equal(result.database.metadata.sourceName, testDb.name);
      assert.ok(result.database.metadata.backupTimestamp);

      // Verify the backup file exists and is indeed a copy at a different path
      const backupFilePath = result.database.url;
      assert.ok(backupFilePath);
      assert.ok(fs.existsSync(backupFilePath));
      assert.notEqual(backupFilePath, sourceSqlitePath); // Must be a separate physical file

      // Query backup file to verify data was correctly copied byte-by-byte
      const backupClient = new SqliteClient(backupFilePath);
      const rows = await backupClient.all('SELECT name FROM test_table');
      backupClient.close();

      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'original_data');
    });

    test('fails if the source database does not exist in DB repository', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      await assert.rejects(
        databaseService.backupDatabase(fakeUuid, { name: 'failed-backup' }),
        /source database not found/
      );
    });

    test('fails if the source database physical file does not exist on disk', async () => {
      // Create a DB record referencing a non-existent physical file path
      const dbRepo = AppDataSource.getRepository(Database);
      const dbNoFile = await dbRepo.save(
        dbRepo.create({
          name: 'no-file-db',
          type: 'sqlite',
          status: 'active',
          url: path.join(tempDir, 'non-existent.db'),
          subdomain: 'no-file-subdomain',
          project: testProject,
        })
      );

      await assert.rejects(
        databaseService.backupDatabase(dbNoFile.id, { name: 'failed-backup-file' }),
        /source database file not found on disk/
      );
    });
  });

  // ==========================================
  // HTTP Controller / Route API Tests
  // ==========================================
  test.describe('API HTTP Routes & Controller', () => {
    test('successfully performs database backup through POST /api/v1/databases/:id/backup', async () => {
      const backupRes = await app.inject({
        method: 'POST',
        url: `/api/v1/databases/${apiDbId}/backup`,
        headers: {
          cookie: cookieHeader,
          'x-csrf-token-v2': csrfToken
        },
        payload: { name: 'api-backup-copy' }
      });

      assert.equal(backupRes.statusCode, 201);
      const body = JSON.parse(backupRes.payload);
      assert.ok(body.database);
      assert.ok(body.token);
      assert.equal(body.database.name, 'api-backup-copy');
      assert.equal(body.database.metadata.backup, true);
      assert.equal(body.database.metadata.sourceId, apiDbId);

      // Verify the backup file exists
      assert.ok(body.database.url);
      assert.ok(fs.existsSync(body.database.url));
    });

    test('returns 400 when name is missing or empty in payload', async () => {
      const backupRes = await app.inject({
        method: 'POST',
        url: `/api/v1/databases/${apiDbId}/backup`,
        headers: {
          cookie: cookieHeader,
          'x-csrf-token-v2': csrfToken
        },
        payload: { name: '   ' }
      });

      assert.equal(backupRes.statusCode, 400);
      const body = JSON.parse(backupRes.payload);
      assert.equal(body.error, 'name is required for the backup database');
    });

    test('returns 403 when csrf token is missing or invalid', async () => {
      const backupRes = await app.inject({
        method: 'POST',
        url: `/api/v1/databases/${apiDbId}/backup`,
        headers: {
          cookie: cookieHeader,
          'x-csrf-token-v2': 'wrong-token'
        },
        payload: { name: 'api-backup-copy' }
      });

      assert.equal(backupRes.statusCode, 403);
      const body = JSON.parse(backupRes.payload);
      assert.equal(body.error, 'invalid csrf token');
    });
  });
});

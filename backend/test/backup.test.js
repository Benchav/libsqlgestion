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
const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');

test.describe('Database Backup Integration Tests', () => {
  let databaseService;
  let testProject;
  let testDb;
  let sourceSqlitePath;

  test.before(async () => {
    // Initialize isolated AppDataSource
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();

    databaseService = new DatabaseService();

    // 1. Create a mock Project in DB
    const projectRepo = AppDataSource.getRepository(Project);
    testProject = await projectRepo.save(
      projectRepo.create({
        name: 'Backup Test Project',
        description: 'Testing backup flow',
      })
    );

    // 2. Create a physical SQLite database that has some dummy data to act as the source database
    const sourceDbDir = path.join(storageRoot, 'source-dbs');
    fs.mkdirSync(sourceDbDir, { recursive: true });
    sourceSqlitePath = path.join(sourceDbDir, 'original.db');

    const client = new SqliteClient(sourceSqlitePath);
    await client.exec(`
      CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO test_table (name) VALUES ('original_data');
    `);
    client.close();

    // 3. Create a Database record in DB referencing the source file as the URL
    const dbRepo = AppDataSource.getRepository(Database);
    testDb = await dbRepo.save(
      dbRepo.create({
        name: 'original-db',
        type: 'sqlite',
        status: 'active',
        url: sourceSqlitePath,
        subdomain: 'original-subdomain',
        project: testProject,
      })
    );
  });

  test.after(async () => {
    await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

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

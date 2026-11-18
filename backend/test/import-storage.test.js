const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-import-storage-'));
process.env.SQLITE_STORAGE_ROOT = path.join(tempDir, 'storage');
process.env.SQLD_DATA_DIR = path.join(tempDir, 'sqld');

const { SqliteStorageService } = require('../dist/infrastructure/storage/SqliteStorageService');
const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');

async function createSqliteFixture(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const client = new SqliteClient(filePath);
  try {
    await client.execAtomic(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO items (name) VALUES ('${value}');
    `);
    await client.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    await client.close();
  }
}

async function countItems(filePath) {
  const client = new SqliteClient(filePath);
  try {
    const rows = await client.all('SELECT COUNT(*) AS count FROM items');
    return Number(rows[0].count);
  } finally {
    await client.close();
  }
}

test.describe('Fast SQLite import storage', () => {
  test.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('copies uploaded snapshots without VACUUM INTO', async () => {
    const source = path.join(tempDir, 'uploads', 'uploaded.db');
    await createSqliteFixture(source, 'uploaded');

    const service = new SqliteStorageService();
    const target = await service.importDatabaseFile(
      source,
      'project-1',
      'database-1',
      'sqlite',
      { consistentSnapshot: false },
    );

    assert.equal(fs.existsSync(target), true);
    assert.equal(await countItems(target), 1);
  });

  test('moves a staged upload instead of copying it', async () => {
    const source = path.join(tempDir, 'uploads', 'moved.db');
    await createSqliteFixture(source, 'moved');

    const service = new SqliteStorageService();
    const target = await service.importDatabaseFile(
      source,
      'project-1b',
      'database-1b',
      'sqlite',
      { consistentSnapshot: false, moveSource: true },
    );

    assert.equal(fs.existsSync(source), false, 'the staging file should be moved');
    assert.equal(fs.existsSync(target), true);
    assert.equal(await countItems(target), 1);
  });

  test('keeps VACUUM INTO for live server paths', async () => {
    const source = path.join(tempDir, 'live', 'server.db');
    await createSqliteFixture(source, 'server');

    const service = new SqliteStorageService();
    const target = await service.importDatabaseFile(
      source,
      'project-2',
      'database-2',
      'sqlite',
    );

    assert.equal(fs.existsSync(target), true);
    assert.equal(await countItems(target), 1);
  });

  test('rejects files without a SQLite header', async () => {
    const source = path.join(tempDir, 'uploads', 'fake.db');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'this is not a database');

    const service = new SqliteStorageService();
    await assert.rejects(
      () => service.importDatabaseFile(source, 'project-3', 'database-3', 'sqlite', {
        consistentSnapshot: false,
      }),
      (error) => {
        assert.equal(error.statusCode, 422);
        assert.match(error.message, /not a valid SQLite database/i);
        return true;
      },
    );
  });

  test('copies uploaded snapshots into a shared namespace', async () => {
    const source = path.join(tempDir, 'uploads', 'namespace.db');
    await createSqliteFixture(source, 'namespace');

    const service = new SqliteStorageService();
    const target = await service.importToNamespace(source, 'erp-db', {
      consistentSnapshot: false,
    });

    assert.equal(target, path.join(tempDir, 'sqld', 'data', 'dbs', 'erp-db', 'data'));
    assert.equal(await countItems(target), 1);
  });
});

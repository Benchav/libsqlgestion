const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SQLITE_READ_POOL_SIZE = '2';
process.env.SQLITE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-read-pool-'));

const { ConnectionPool } = require('../dist/infrastructure/db/ConnectionPool');

const databaseFile = path.join(process.env.SQLITE_STORAGE_ROOT, 'pool.db');
fs.writeFileSync(databaseFile, '');

const database = {
  id: 'read-pool-test',
  name: 'read-pool-test',
  type: 'sqlite',
  url: databaseFile,
  status: 'active',
  metadata: { runtime: { provider: 'local-file' } },
  project: { id: 'project-1' },
};

test.after(async () => {
  await ConnectionPool.getInstance().shutdown();
  fs.rmSync(process.env.SQLITE_STORAGE_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('local SQLite reads use independent WAL connections', async () => {
  const pool = ConnectionPool.getInstance();
  const first = await pool.getReadClient(database);
  const second = await pool.getReadClient(database);

  assert.notEqual(first, second, 'concurrent reads must not share one sqlite3 handle');

  const results = await Promise.all(
    Array.from({ length: 20 }, async (_, index) => (
      (await pool.getReadClient(database)).all('SELECT ? AS n', [index])
    )),
  );
  assert.equal(results.length, 20);
  assert.deepEqual(results.map((rows) => Number(rows[0].n)).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, index) => index));
});

test('evicting a database closes its read pool', async () => {
  const pool = ConnectionPool.getInstance();
  await pool.getReadClient(database);
  await pool.getReadClient(database);
  assert.equal(pool['readPool'].get(database.id).clients.length, 2);

  pool.evict(database.id);
  assert.equal(pool['readPool'].has(database.id), false);
});

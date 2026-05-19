const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');

test('script execution can be summarized per statement', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-script-details-'));
  const dbPath = path.join(tempDir, 'test.db');
  const client = new SqliteClient(dbPath);

  try {
    await client.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);`);
    await client.exec(`INSERT INTO users (name) VALUES ('A'); INSERT INTO users (name) VALUES ('B');`);

    const rows = await client.all('SELECT COUNT(*) AS cnt FROM users');
    assert.equal(rows[0].cnt, 2);
  } finally {
    client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

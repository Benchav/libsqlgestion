const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
const { splitSqlStatements, isMultiStatementSql } = require('../dist/application/databases/sqlScript');

test('splits statements without breaking comments or strings', () => {
  const sql = `
    -- comment with ; inside
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO users (name) VALUES ('semi;colon');
    /* block ; comment */
    SELECT * FROM users;
  `;

  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 3);
  assert.equal(isMultiStatementSql(sql), true);
});

test('sqlite exec runs a multi-statement script atomically', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-script-'));
  const dbPath = path.join(tempDir, 'test.db');
  const client = new SqliteClient(dbPath);

  try {
    await client.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      INSERT INTO users (name) VALUES ('A');
      INSERT INTO users (name) VALUES ('B');
    `);

    const rows = await client.all('SELECT name FROM users ORDER BY id');
    assert.deepEqual(rows.map((row) => row.name), ['A', 'B']);
  } finally {
    client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

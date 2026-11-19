const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.SNAPSHOT_LIBSQL_MAX_BYTES = String(64 * 1024 * 1024);
process.env.SNAPSHOT_LIBSQL_DUMP_TIMEOUT_MS = '5000';

const {
  buildLibsqlDumpTarget,
  fetchLibsqlDump,
  validateLibsqlDump,
  replaySqlDumpToSqlite,
  streamSqlStatements,
  fileSha256,
} = require('../dist/application/snapshots/libsql-dump');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-dump-test-'));
const dumpPath = path.join(tempDir, 'snapshot.sql');

const DUMP = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO users(id,name) VALUES(1,'Ana');
INSERT INTO users(id,name) VALUES(2,'Luis');
COMMIT;
`;

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('builds a dedicated runtime dump target without namespace headers', () => {
  const target = buildLibsqlDumpTarget({
    metadata: {
      runtime: {
        provider: 'docker-libsql',
        internalUrl: 'http://libsqlite-db:8080',
        namespace: undefined,
      },
    },
  });

  assert.equal(target.url, 'http://libsqlite-db:8080/dump?preserve_row_ids=true');
  assert.deepEqual(target.headers, {});
});

test('builds a namespace dump target with x-namespace', () => {
  const target = buildLibsqlDumpTarget({
    metadata: {
      runtime: {
        provider: 'sqld-namespace',
        internalUrl: 'http://sqld:8080/dev/erp/',
        namespace: 'erp',
      },
    },
  });

  assert.equal(target.url, 'http://sqld:8080/dump?preserve_row_ids=true');
  assert.equal(target.headers['x-namespace'], 'erp');
});

test('rejects unsupported remote databases', () => {
  assert.throws(
    () => buildLibsqlDumpTarget({ metadata: { runtime: { provider: 'remote' } } }),
    /managed libSQL primaries/,
  );
});

test('streams, validates, and hashes a libSQL dump', async () => {
  let requestPath = '';
  let authorization = '';
  const server = http.createServer((request, response) => {
    requestPath = request.url || '';
    authorization = String(request.headers.authorization || '');
    response.writeHead(200, { 'Content-Type': 'application/sql' });
    response.end(DUMP);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    const result = await fetchLibsqlDump(
      {
        metadata: {
          runtime: {
            provider: 'docker-libsql',
            internalUrl: `http://127.0.0.1:${port}`,
          },
        },
      },
      'test-token',
      dumpPath,
    );

    assert.equal(requestPath, '/dump?preserve_row_ids=true');
    assert.equal(authorization, 'Bearer test-token');
    assert.ok(result.bytes > 0);

    const validation = await validateLibsqlDump(dumpPath);
    assert.equal(validation.sizeBytes, Buffer.byteLength(DUMP));
    assert.equal(await fileSha256(dumpPath), require('node:crypto').createHash('sha256').update(DUMP).digest('hex'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rejects a truncated dump', async () => {
  const truncated = path.join(tempDir, 'truncated.sql');
  fs.writeFileSync(truncated, 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t (id INTEGER);\n');
  await assert.rejects(() => validateLibsqlDump(truncated), /truncated|COMMIT/i);
});

test('streams statements without splitting quoted semicolons', async () => {
  const tricky = path.join(tempDir, 'tricky.sql');
  fs.writeFileSync(
    tricky,
    "INSERT INTO users(name) VALUES('a; b');\nINSERT INTO users(name) VALUES('c');\n",
  );
  const statements = [];
  for await (const statement of streamSqlStatements(tricky)) {
    statements.push(statement);
  }
  assert.equal(statements.length, 2);
  assert.match(statements[0], /a; b/);
});

test('keeps trigger bodies with internal semicolons as one statement', async () => {
  const triggerDump = path.join(tempDir, 'trigger.sql');
  fs.writeFileSync(triggerDump, `CREATE TRIGGER audit_users AFTER INSERT ON users
BEGIN
  INSERT INTO audit_log(action) VALUES('insert');
  UPDATE counters SET value = value + 1;
END;
INSERT INTO users(name) VALUES('next');
`);

  const statements = [];
  for await (const statement of streamSqlStatements(triggerDump)) {
    statements.push(statement);
  }

  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE TRIGGER/);
  assert.match(statements[0], /INSERT INTO audit_log/);
  assert.match(statements[0], /UPDATE counters/);
  assert.match(statements[1], /INSERT INTO users/);
});

test('replays trigger bodies and fires them after restore', async () => {
  const triggerDump = path.join(tempDir, 'trigger-replay.sql');
  fs.writeFileSync(triggerDump, `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL);
CREATE TRIGGER audit_users AFTER INSERT ON users
BEGIN
  INSERT INTO audit_log(action) VALUES('insert');
  UPDATE audit_log SET action = action WHERE id = last_insert_rowid();
END;
INSERT INTO users(name) VALUES('first');
COMMIT;
`);

  const target = path.join(tempDir, 'trigger-replay.db');
  await replaySqlDumpToSqlite(triggerDump, target);

  const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
  const client = new SqliteClient(target);
  try {
    const rows = await client.all('SELECT COUNT(*) AS cnt FROM users');
    assert.equal(Number(rows[0].cnt), 1);
    const audit = await client.all('SELECT COUNT(*) AS cnt FROM audit_log');
    assert.equal(Number(audit[0].cnt), 1);
  } finally {
    await client.close();
  }
});

test('replays a libSQL dump into a verified SQLite database', async () => {
  const target = path.join(tempDir, 'restored.db');
  await replaySqlDumpToSqlite(dumpPath, target);

  const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
  const client = new SqliteClient(target);
  try {
    const rows = await client.all('SELECT id, name FROM users ORDER BY id');
    assert.deepEqual(rows, [{ id: 1, name: 'Ana' }, { id: 2, name: 'Luis' }]);
    const integrity = await client.checkIntegrity();
    assert.equal(integrity.ok, true);
  } finally {
    await client.close();
  }
});

test('replays FTS5 virtual tables emitted through writable_schema', async () => {
  const source = path.join(tempDir, 'fts-dump.sql');
  fs.writeFileSync(source, `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);
INSERT INTO notes(id,body) VALUES(1,'hello world');
PRAGMA writable_schema=ON;
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','notes_fts','notes_fts',0,'CREATE VIRTUAL TABLE notes_fts USING fts5(body, content=''notes'', content_rowid=''id'')');
PRAGMA writable_schema=OFF;
COMMIT;
`);

  const target = path.join(tempDir, 'fts-restored.db');
  await replaySqlDumpToSqlite(source, target);

  const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
  const client = new SqliteClient(target);
  try {
    const objects = await client.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    assert.ok(objects.some((row) => row.name === 'notes_fts'));
    const rows = await client.all('SELECT COUNT(*) AS cnt FROM notes');
    assert.equal(Number(rows[0].cnt), 1);
    // This synthetic fixture omits the FTS5 shadow-table rows that sqld emits
    // in a real dump; the normal-table test above asserts full integrity.
  } finally {
    await client.close();
  }
});

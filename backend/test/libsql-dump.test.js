const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

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

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString('hex')}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

/**
 * Produces a dump in the same shape as sqld's /dump exporter: virtual tables
 * are registered through writable_schema, shadow tables are dumped as regular
 * tables, and data rows follow the schema.
 */
async function exportSqldLikeDump(sourcePath, dumpPath) {
  const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
  const client = new SqliteClient(sourcePath);
  const lines = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  let writableSchema = false;

  try {
    const tables = await client.all(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY rowid",
    );

    if (tables.some((table) => table.name === 'sqlite_sequence')) {
      lines.push('DELETE FROM sqlite_sequence;');
    }

    for (const table of tables) {
      if (table.name === 'sqlite_sequence') continue;
      if (table.name.startsWith('sqlite_')) continue;

      if (table.sql.startsWith('CREATE VIRTUAL TABLE')) {
        if (!writableSchema) {
          lines.push('PRAGMA writable_schema=ON;');
          writableSchema = true;
        }
        const name = String(table.name).replace(/'/g, "''");
        lines.push(
          "INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)" +
          `VALUES('table','${name}','${name}',0,${sqlLiteral(table.sql)});`,
        );
        continue;
      }

      lines.push(`CREATE TABLE IF NOT EXISTS ${table.sql.replace(/^CREATE TABLE\s+/i, '')};`);
      const rows = await client.all(`SELECT * FROM ${quoteIdentifier(table.name)}`);
      for (const row of rows) {
        const columns = Object.keys(row);
        lines.push(
          `INSERT INTO ${quoteIdentifier(table.name)}` +
          `(${columns.map(quoteIdentifier).join(',')}) ` +
          `VALUES(${columns.map((column) => sqlLiteral(row[column])).join(',')});`,
        );
      }
    }

    if (writableSchema) {
      lines.push('PRAGMA writable_schema=OFF;');
    }

    const schemaObjects = await client.all(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('index','trigger','view')",
    );
    for (const object of schemaObjects) {
      lines.push(`${object.sql};`);
    }

    lines.push('COMMIT;', '');
    fs.writeFileSync(dumpPath, lines.join('\n'));
  } finally {
    await client.close();
  }
}

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

test('keeps bracketed identifiers and comment delimiters split across chunks', async () => {
  const originalCreateReadStream = fs.createReadStream;
  try {
    fs.createReadStream = () => Readable.from([
      'CREATE TABLE [a;b] (id INTEGER); /* comment *',
      '/ INSERT INTO [a;b] VALUES(1);',
    ]);

    const statements = [];
    for await (const statement of streamSqlStatements('memory-only')) {
      statements.push(statement);
    }

    assert.equal(statements.length, 2);
    assert.match(statements[0], /\[a;b\]/);
    assert.match(statements[1], /INSERT INTO \[a;b\]/);
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
});

test('detects a trigger preceded by a comment', async () => {
  const originalCreateReadStream = fs.createReadStream;
  try {
    fs.createReadStream = () => Readable.from([
      '-- saved trigger\nCREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(1); INSERT INTO audit VALUES(2); END;\nSELECT 1;',
    ]);

    const statements = [];
    for await (const statement of streamSqlStatements('memory-only')) {
      statements.push(statement);
    }

    assert.equal(statements.length, 2);
    assert.match(statements[0], /CREATE TRIGGER/);
    assert.match(statements[0], /INSERT INTO audit VALUES\(2\)/);
    assert.match(statements[0], /END$/);
    assert.match(statements[1], /SELECT 1/);
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
});

test('rejects a dump whose only COMMIT appears inside row data', async () => {
  const misleading = path.join(tempDir, 'misleading.sql');
  fs.writeFileSync(
    misleading,
    "BEGIN TRANSACTION;\nINSERT INTO notes(body) VALUES('COMMIT;');\n",
  );
  await assert.rejects(() => validateLibsqlDump(misleading), /truncated|COMMIT/i);
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

test('reapplies source pragmas to the materialized database', async () => {
  const target = path.join(tempDir, 'pragmas.db');
  await replaySqlDumpToSqlite(dumpPath, target, {
    userVersion: 7,
    applicationId: 123456,
    pageSize: 4096,
    encoding: 'UTF-8',
    autoVacuum: 1,
  });

  const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
  const client = new SqliteClient(target);
  try {
    const userVersion = await client.get('PRAGMA user_version');
    const applicationId = await client.get('PRAGMA application_id');
    const pageSize = await client.get('PRAGMA page_size');
    const encoding = await client.get('PRAGMA encoding');
    const autoVacuum = await client.get('PRAGMA auto_vacuum');

    assert.equal(Number(userVersion.user_version), 7);
    assert.equal(Number(applicationId.application_id), 123456);
    assert.equal(Number(pageSize.page_size), 4096);
    assert.equal(encoding.encoding, 'UTF-8');
    assert.equal(Number(autoVacuum.auto_vacuum), 1);

    const rows = await client.all('SELECT id, name FROM users ORDER BY id');
    assert.deepEqual(rows, [{ id: 1, name: 'Ana' }, { id: 2, name: 'Luis' }]);
  } finally {
    await client.close();
  }
});

test('round-trips a real FTS5 database and supports MATCH after reopen', async () => {
  const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
  const sourcePath = path.join(tempDir, 'fts-source.db');
  const source = new SqliteClient(sourcePath);
  try {
    await source.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);');
    await source.exec('CREATE VIRTUAL TABLE notes_fts USING fts5(body);');
    await source.exec("INSERT INTO notes_fts(rowid, body) VALUES (1, 'hello world'), (2, 'another document');");
  } finally {
    await source.close();
  }

  const dump = path.join(tempDir, 'fts-real.sql');
  await exportSqldLikeDump(sourcePath, dump);
  await validateLibsqlDump(dump);

  const target = path.join(tempDir, 'fts-restored.db');
  await replaySqlDumpToSqlite(dump, target);

  const client = new SqliteClient(target);
  try {
    const integrity = await client.checkIntegrity();
    assert.equal(integrity.ok, true, integrity.details);

    const matches = await client.all(
      "SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'hello' ORDER BY rowid",
    );
    assert.deepEqual(matches.map((row) => Number(row.rowid)), [1]);
  } finally {
    await client.close();
  }
});

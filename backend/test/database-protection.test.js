const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-protection-'));
const testDbPath = path.join(tempDir, 'control.db');
const storageRoot = path.join(tempDir, 'storage');

process.env.DATABASE_FILE = testDbPath;
process.env.SQLITE_STORAGE_ROOT = storageRoot;
process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.LIBSQL_ADMIN_URL = '';
process.env.LIBSQL_ENABLE_NAMESPACES = 'false';
process.env.LIBSQL_NAMESPACE_IMPORTS = 'false';
process.env.LIBSQL_IMPORT_RUNTIME = 'false';
process.env.DOCKER_SOCKET_PATH = path.join(tempDir, 'no-docker.sock');
process.env.GATEWAY_INTERNAL_TOKEN = 'test-gateway-token';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { ConnectionPool } = require('../dist/infrastructure/db/ConnectionPool');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
const { buildServer } = require('../dist/server');
const { classifySqlStatement } = require('../dist/application/databases/sql-guard');
const { tokenInvalidationScope } = require('../dist/application/databases/database-protection');
const { Database } = require('../dist/domain/entities/Database');

test.describe('Database protection controls', () => {
  let app;
  let cookieHeader;
  let csrfToken;
  let projectId;
  let databaseId;
  let databaseToken;
  let fixturePath;

  function authHeaders() {
    return { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken };
  }

  async function setProtection(flags) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/databases/${databaseId}/protection`,
      headers: authHeaders(),
      payload: flags,
    });
  }

  async function query(sql) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/query`,
      headers: authHeaders(),
      payload: { sql, params: [] },
    });
  }

  async function pipeline(sql, token = databaseToken) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/v2/pipeline`,
      headers: { authorization: `Bearer ${token}` },
      payload: { requests: [{ type: 'execute', stmt: { sql } }] },
    });
  }

  test.before(async () => {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();

    const fixtureDir = path.join(tempDir, 'fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fixturePath = path.join(fixtureDir, 'protection.db');

    const fixture = new SqliteClient(fixturePath);
    await fixture.execAtomic(`
      CREATE TABLE clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL
      );
      INSERT INTO clientes (nombre) VALUES ('Acme');
    `);
    await fixture.close();

    app = buildServer();

    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'protection@test.test', password: 'ProtectionTest123!' },
    });
    assert.equal(register.statusCode, 200, register.payload);

    const cookieMap = {};
    const setCookies = register.headers['set-cookie'];
    for (const item of Array.isArray(setCookies) ? setCookies : [setCookies]) {
      const [kv] = item.split(';');
      const [key, value] = kv.split('=');
      cookieMap[key.trim()] = value.trim();
    }
    csrfToken = cookieMap['libsqlite.csrfToken.v2'] || cookieMap['libsqlite.csrfToken'];
    cookieHeader = `libsqlite.accessToken=${cookieMap['libsqlite.accessToken']}; libsqlite.csrfToken.v2=${csrfToken}`;

    const project = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: authHeaders(),
      payload: { name: 'Protection Project' },
    });
    assert.equal(project.statusCode, 201, project.payload);
    projectId = JSON.parse(project.payload).project.id;

    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/import-sqlite',
      headers: authHeaders(),
      payload: {
        projectId,
        name: 'protection-db',
        sourcePath: fixturePath,
      },
    });
    assert.equal(imported.statusCode, 201, imported.payload);
    const importedBody = JSON.parse(imported.payload);
    databaseId = importedBody.database.id;
    databaseToken = importedBody.token;
    assert.equal(importedBody.database.type, 'sqlite');
    assert.equal(importedBody.database.blockReads, false);
    assert.equal(importedBody.database.blockWrites, false);
    assert.equal(importedBody.database.deleteProtection, false);
    assert.equal('encryptedToken' in importedBody.database, false);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${databaseId}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    const detailDatabase = JSON.parse(detail.payload).database;
    assert.equal('encryptedToken' in detailDatabase, false);
    assert.equal(detailDatabase.project.owner.passwordHash, undefined);
  });

  test.after(async () => {
    await ConnectionPool.getInstance().shutdown();
    if (app) await app.close();
    await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('exposes a token-protected gateway policy for direct clients', async () => {
    const row = await AppDataSource.getRepository(Database).findOneByOrFail({ id: databaseId });
    const host = `${row.subdomain}.data.test`;
    const policy = await app.inject({
      method: 'GET',
      url: `/api/v1/internal/gateway/policy?host=${encodeURIComponent(host)}`,
      headers: { 'x-gateway-token': 'test-gateway-token' },
    });
    assert.equal(policy.statusCode, 200, policy.payload);
    const body = JSON.parse(policy.payload);
    assert.equal(body.databaseId, databaseId);
    assert.equal(body.provider, 'local-file');
    assert.equal(body.blockReads, false);
    assert.equal(body.blockWrites, false);
    assert.match(body.upstreamBaseUrl, new RegExp(`/api/v1/databases/${databaseId}$`));

    const unauthorized = await app.inject({
      method: 'GET',
      url: `/api/v1/internal/gateway/policy?host=${encodeURIComponent(host)}`,
      headers: { 'x-gateway-token': 'wrong' },
    });
    assert.equal(unauthorized.statusCode, 401, unauthorized.payload);
  });

  test('classifies reads, writes and mutating pragmas conservatively', () => {
    assert.equal(classifySqlStatement('SELECT * FROM clientes').operation, 'read');
    assert.equal(classifySqlStatement('WITH x AS (SELECT 1) SELECT * FROM x').operation, 'read');
    assert.equal(classifySqlStatement('WITH x AS (SELECT 1) INSERT INTO clientes(nombre) SELECT * FROM x').operation, 'write');
    assert.equal(classifySqlStatement('INSERT INTO clientes(nombre) VALUES (?) RETURNING id').returnsRows, true);
    assert.equal(classifySqlStatement('PRAGMA table_info(clientes)').operation, 'read');
    assert.equal(classifySqlStatement('PRAGMA integrity_check(1)').operation, 'read');
    assert.equal(classifySqlStatement('PRAGMA journal_mode=WAL').operation, 'write');
    assert.equal(classifySqlStatement('PRAGMA journal_mode(WAL)').operation, 'write');
    assert.equal(classifySqlStatement('PRAGMA wal_checkpoint').operation, 'write');
    assert.equal(classifySqlStatement('CREATE TABLE x (id INTEGER)').operation, 'write');
    assert.equal(classifySqlStatement('BEGIN TRANSACTION').operation, 'neutral');
    assert.equal(
      classifySqlStatement("SELECT 'INSERT INTO x; DROP TABLE y' AS harmless").operation,
      'read',
    );

    assert.equal(tokenInvalidationScope({ type: 'sqlite', url: '/tmp/a.db', metadata: null }), 'all');
    assert.equal(tokenInvalidationScope({
      type: 'libsql',
      url: 'libsql://db.example.test',
      metadata: { runtime: { provider: 'sqld-namespace' } },
    }), 'panel-only');
    assert.equal(tokenInvalidationScope({
      type: 'remote',
      url: 'https://external.example.test',
      metadata: null,
    }), 'unsupported');
  });

  test('blocks read operations without blocking writes', async () => {
    const enabled = await setProtection({ blockReads: true });
    assert.equal(enabled.statusCode, 200, enabled.payload);
    assert.equal(JSON.parse(enabled.payload).database.blockReads, true);

    const blockedQuery = await query('SELECT * FROM clientes');
    assert.equal(blockedQuery.statusCode, 403, blockedQuery.payload);
    assert.equal(JSON.parse(blockedQuery.payload).code, 'DATABASE_READS_BLOCKED');

    const blockedPipeline = await pipeline('SELECT * FROM clientes');
    assert.equal(blockedPipeline.statusCode, 403, blockedPipeline.payload);

    const blockedSchema = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${databaseId}/schema`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(blockedSchema.statusCode, 403, blockedSchema.payload);

    const blockedDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${databaseId}/download`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(blockedDownload.statusCode, 403, blockedDownload.payload);

    const returningBlocked = await query(
      "INSERT INTO clientes (nombre) VALUES ('Read Returning Blocked') RETURNING id",
    );
    assert.equal(returningBlocked.statusCode, 403, returningBlocked.payload);

    const writeAllowed = await query("INSERT INTO clientes (nombre) VALUES ('Read Block Write')");
    assert.equal(writeAllowed.statusCode, 200, writeAllowed.payload);

    const disabled = await setProtection({ blockReads: false });
    assert.equal(disabled.statusCode, 200, disabled.payload);
    const returningCount = await query(
      "SELECT COUNT(*) AS cnt FROM clientes WHERE nombre = 'Read Returning Blocked'",
    );
    assert.equal(returningCount.statusCode, 200, returningCount.payload);
    assert.equal(Number(JSON.parse(returningCount.payload).rows[0].cnt), 0);
    const readAgain = await query('SELECT COUNT(*) AS cnt FROM clientes');
    assert.equal(readAgain.statusCode, 200, readAgain.payload);
  });

  test('blocks write operations without blocking reads', async () => {
    const enabled = await setProtection({ blockWrites: true });
    assert.equal(enabled.statusCode, 200, enabled.payload);

    const blockedQuery = await query("INSERT INTO clientes (nombre) VALUES ('Blocked')");
    assert.equal(blockedQuery.statusCode, 403, blockedQuery.payload);
    assert.equal(JSON.parse(blockedQuery.payload).code, 'DATABASE_WRITES_BLOCKED');

    const blockedPipeline = await pipeline("INSERT INTO clientes (nombre) VALUES ('Blocked')");
    assert.equal(blockedPipeline.statusCode, 403, blockedPipeline.payload);

    const blockedPragma = await query('PRAGMA journal_mode=WAL');
    assert.equal(blockedPragma.statusCode, 403, blockedPragma.payload);

    const allowedPragma = await query('PRAGMA table_info(clientes)');
    assert.equal(allowedPragma.statusCode, 200, allowedPragma.payload);

    const allowedRead = await query('SELECT COUNT(*) AS cnt FROM clientes');
    assert.equal(allowedRead.statusCode, 200, allowedRead.payload);

    const allowedReadScript = await query('SELECT 1; SELECT 2;');
    assert.equal(allowedReadScript.statusCode, 200, allowedReadScript.payload);

    // Defence in depth: even a caller that reaches the pooled SQLite client
    // directly must be stopped by PRAGMA query_only.
    await ConnectionPool.getInstance().setQueryOnly(databaseId, true);
    const protectedRow = await AppDataSource.getRepository(Database).findOneByOrFail({ id: databaseId });
    const pooledClient = ConnectionPool.getInstance().getClient(protectedRow);
    await assert.rejects(
      () => pooledClient.run("INSERT INTO clientes (nombre) VALUES ('Query Only Blocked')"),
      /read-?only|query_only/i,
    );

    const mixedBatch = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/v2/pipeline`,
      headers: { authorization: `Bearer ${databaseToken}` },
      payload: {
        requests: [
          {
            type: 'batch',
            batch: {
              steps: [
                { stmt: { sql: 'SELECT 1' } },
                { stmt: { sql: "INSERT INTO clientes (nombre) VALUES ('Batch Blocked')" } },
              ],
            },
          },
        ],
      },
    });
    assert.equal(mixedBatch.statusCode, 403, mixedBatch.payload);

    const storedSql = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/v2/pipeline`,
      headers: { authorization: `Bearer ${databaseToken}` },
      payload: {
        requests: [
          {
            type: 'store_sql',
            sql_id: 7,
            sql: "INSERT INTO clientes (nombre) VALUES ('Stored Blocked')",
          },
          { type: 'execute', stmt: { sql_id: 7 } },
        ],
      },
    });
    assert.equal(storedSql.statusCode, 403, storedSql.payload);

    const writeSequence = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/v2/pipeline`,
      headers: { authorization: `Bearer ${databaseToken}` },
      payload: {
        requests: [
          { type: 'sequence', sql: "SELECT 1; INSERT INTO clientes (nombre) VALUES ('Sequence Blocked');" },
        ],
      },
    });
    assert.equal(writeSequence.statusCode, 403, writeSequence.payload);

    const afterBatch = await query("SELECT COUNT(*) AS cnt FROM clientes WHERE nombre IN ('Batch Blocked', 'Stored Blocked', 'Sequence Blocked')");
    assert.equal(afterBatch.statusCode, 200, afterBatch.payload);
    assert.equal(Number(JSON.parse(afterBatch.payload).rows[0].cnt), 0);

    const disabled = await setProtection({ blockWrites: false });
    assert.equal(disabled.statusCode, 200, disabled.payload);
    const writeAgain = await query("INSERT INTO clientes (nombre) VALUES ('Write Again')");
    assert.equal(writeAgain.statusCode, 200, writeAgain.payload);
  });

  test('delete protection blocks direct and project deletion', async () => {
    const enabled = await setProtection({ deleteProtection: true });
    assert.equal(enabled.statusCode, 200, enabled.payload);

    const blockedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/databases/${databaseId}`,
      headers: authHeaders(),
    });
    assert.equal(blockedDelete.statusCode, 409, blockedDelete.payload);
    assert.equal(JSON.parse(blockedDelete.payload).code, 'DATABASE_DELETE_PROTECTED');

    const blockedProjectDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}`,
      headers: authHeaders(),
    });
    assert.equal(blockedProjectDelete.statusCode, 409, blockedProjectDelete.payload);
    assert.equal(JSON.parse(blockedProjectDelete.payload).code, 'DATABASE_DELETE_PROTECTED');

    const disabled = await setProtection({ deleteProtection: false });
    assert.equal(disabled.statusCode, 200, disabled.payload);
  });

  test('project deletion cleans up unprotected database resources', async () => {
    const project = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: authHeaders(),
      payload: { name: 'Cleanup Project' },
    });
    assert.equal(project.statusCode, 201, project.payload);
    const cleanupProjectId = JSON.parse(project.payload).project.id;

    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/import-sqlite',
      headers: authHeaders(),
      payload: {
        projectId: cleanupProjectId,
        name: 'cleanup-db',
        sourcePath: fixturePath,
      },
    });
    assert.equal(imported.statusCode, 201, imported.payload);
    const cleanupDatabase = JSON.parse(imported.payload).database;
    assert.equal(fs.existsSync(cleanupDatabase.url), true);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${cleanupProjectId}`,
      headers: authHeaders(),
    });
    assert.equal(removed.statusCode, 200, removed.payload);
    assert.equal(
      await AppDataSource.getRepository(Database).findOneBy({ id: cleanupDatabase.id }),
      null,
    );
    assert.equal(fs.existsSync(cleanupDatabase.url), false);
  });

  test('invalidates the stored token and rejects the previous credential', async () => {
    const oldToken = databaseToken;
    const invalidated = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/invalidate-tokens`,
      headers: authHeaders(),
    });
    assert.equal(invalidated.statusCode, 200, invalidated.payload);
    const body = JSON.parse(invalidated.payload);
    assert.notEqual(body.token, oldToken);
    assert.equal(body.scope, 'all');
    assert.equal(body.provider, 'local-file');
    databaseToken = body.token;

    const oldCredential = await pipeline('SELECT 1', oldToken);
    assert.equal(oldCredential.statusCode, 401, oldCredential.payload);

    const newCredential = await pipeline('SELECT 1', databaseToken);
    assert.equal(newCredential.statusCode, 200, newCredential.payload);
  });

  test('keeps the migration defaults false for existing rows', async () => {
    const row = await AppDataSource.getRepository(Database).findOneByOrFail({ id: databaseId });
    assert.equal(Boolean(row.blockReads), false);
    assert.equal(Boolean(row.blockWrites), false);
    assert.equal(Boolean(row.deleteProtection), false);
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-external-client-'));
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

const { createClient } = require('@libsql/client');
const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { ConnectionPool } = require('../dist/infrastructure/db/ConnectionPool');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
const { buildServer } = require('../dist/server');

test.describe('External @libsql/client compatibility', () => {
  let app;
  let libsqlClient;
  let baseUrl;
  let cookieHeader;
  let csrfToken;
  let projectId;
  let databaseId;
  let databaseToken;

  test.before(async () => {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();

    const fixtureDir = path.join(tempDir, 'fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixturePath = path.join(fixtureDir, 'external-client.db');

    const fixture = new SqliteClient(fixturePath);
    await fixture.execAtomic(`
      CREATE TABLE clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        email TEXT
      );
      INSERT INTO clientes (nombre, email) VALUES
        ('Acme Corp', 'info@acme.test'),
        ('Beta LLC', 'hola@beta.test');
    `);
    await fixture.close();

    app = buildServer();

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'external-client@test.test', password: 'ExternalTest123!' },
    });
    assert.equal(regRes.statusCode, 200);

    const setCookies = regRes.headers['set-cookie'];
    const cookieMap = {};
    for (const item of Array.isArray(setCookies) ? setCookies : [setCookies]) {
      const [kv] = item.split(';');
      const [k, v] = kv.split('=');
      cookieMap[k.trim()] = v.trim();
    }
    csrfToken = cookieMap['libsqlite.csrfToken.v2'] || cookieMap['libsqlite.csrfToken'];
    cookieHeader = `libsqlite.accessToken=${cookieMap['libsqlite.accessToken']}; libsqlite.csrfToken.v2=${csrfToken}`;

    const projRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: { name: 'External Client Project' },
    });
    assert.equal(projRes.statusCode, 201);
    projectId = JSON.parse(projRes.payload).project.id;

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/import-sqlite',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: {
        projectId,
        name: 'external-client-db',
        sourcePath: fixturePath,
      },
    });
    assert.equal(importRes.statusCode, 201, importRes.payload);
    const importBody = JSON.parse(importRes.payload);
    databaseId = importBody.database.id;
    databaseToken = importBody.token;
    assert.equal(importBody.database.type, 'sqlite');

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}/api/v1/databases/${databaseId}/`;

    libsqlClient = createClient({
      url: baseUrl,
      authToken: databaseToken,
    });
  });

  test.after(async () => {
    if (libsqlClient) libsqlClient.close();
    await ConnectionPool.getInstance().shutdown();
    if (app) await app.close();
    await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('runs SELECT, named parameters, RETURNING and transactions', async () => {
    const select = await libsqlClient.execute('SELECT * FROM clientes ORDER BY id');
    assert.equal(select.rows.length, 2);
    assert.equal(select.rows[0].nombre, 'Acme Corp');

    const named = await libsqlClient.execute({
      sql: 'SELECT * FROM clientes WHERE id = :id',
      args: { id: 1 },
    });
    assert.equal(named.rows.length, 1);
    assert.equal(named.rows[0].nombre, 'Acme Corp');

    const inserted = await libsqlClient.execute({
      sql: "INSERT INTO clientes (nombre, email) VALUES ('Gamma SA', 'gamma@test.test') RETURNING id, nombre",
    });
    assert.equal(inserted.rows.length, 1);
    assert.equal(inserted.rows[0].nombre, 'Gamma SA');

    const transaction = await libsqlClient.transaction('write');
    await transaction.execute({
      sql: "INSERT INTO clientes (nombre, email) VALUES ('Delta Inc', 'delta@test.test')",
    });
    await transaction.commit();

    const afterCommit = await libsqlClient.execute('SELECT COUNT(*) AS cnt FROM clientes');
    assert.equal(Number(afterCommit.rows[0].cnt), 4);

    const rollbackTransaction = await libsqlClient.transaction('write');
    await rollbackTransaction.execute({
      sql: "INSERT INTO clientes (nombre, email) VALUES ('Rollback Inc', 'rollback@test.test')",
    });
    await rollbackTransaction.rollback();

    const afterRollback = await libsqlClient.execute('SELECT COUNT(*) AS cnt FROM clientes');
    assert.equal(Number(afterRollback.rows[0].cnt), 4);
  });

  test('reveals the current token and rotates it invalidating the old one', async () => {
    const revealRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/reveal-token`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
    });
    assert.equal(revealRes.statusCode, 200, revealRes.payload);
    assert.equal(JSON.parse(revealRes.payload).token, databaseToken);

    const rotateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/databases/${databaseId}/rotate-token`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
    });
    assert.equal(rotateRes.statusCode, 200, rotateRes.payload);
    const newToken = JSON.parse(rotateRes.payload).token;
    assert.notEqual(newToken, databaseToken);

    const oldTokenRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/v2/pipeline`,
      headers: { authorization: `Bearer ${databaseToken}` },
      payload: { requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }] },
    });
    assert.equal(oldTokenRes.statusCode, 401, oldTokenRes.payload);

    const newTokenRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/v2/pipeline`,
      headers: { authorization: `Bearer ${newToken}` },
      payload: { requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }] },
    });
    assert.equal(newTokenRes.statusCode, 200, newTokenRes.payload);

    const revealAfterRotate = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/reveal-token`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
    });
    assert.equal(revealAfterRotate.statusCode, 200, revealAfterRotate.payload);
    assert.equal(JSON.parse(revealAfterRotate.payload).token, newToken);

    databaseToken = newToken;
  });

  test('convert-to-runtime fails cleanly when Docker is unavailable', async () => {
    const convertRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${databaseId}/convert-to-runtime`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: { subdomain: 'external-client-runtime' },
    });

    assert.equal(convertRes.statusCode, 503, convertRes.payload);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${databaseId}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(detailRes.statusCode, 200, detailRes.payload);
    const detail = JSON.parse(detailRes.payload).database;
    assert.equal(detail.runtimeProvider, 'local-file');
  });
});

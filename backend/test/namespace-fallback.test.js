const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated environment BEFORE loading compiled modules
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-namespace-fallback-'));
const testDbPath = path.join(tempDir, 'control.db');
const storageRoot = path.join(tempDir, 'storage');

process.env.DATABASE_FILE = testDbPath;
process.env.SQLITE_STORAGE_ROOT = storageRoot;
process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.LIBSQL_ADMIN_URL = 'http://127.0.0.1:1';
process.env.LIBSQL_ENABLE_NAMESPACES = 'true';
process.env.LIBSQL_NAMESPACE_IMPORTS = 'auto';
process.env.LIBSQL_IMPORT_RUNTIME = 'false';
process.env.DOCKER_SOCKET_PATH = path.join(tempDir, 'no-docker.sock');
process.env.SQLD_DATA_DIR = path.join(tempDir, 'sqld');

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { ConnectionPool } = require('../dist/infrastructure/db/ConnectionPool');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
const { encrypt } = require('../dist/infrastructure/crypto');
const { Database } = require('../dist/domain/entities/Database');
const { Project } = require('../dist/domain/entities/Project');
const { buildServer } = require('../dist/server');

test.describe('SQLite import when sqld is unavailable', () => {
  let app;
  let cookieHeader;
  let csrfToken;
  let projectId;
  let sourceFilePath;

  test.before(async () => {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();

    const fixtureDir = path.join(tempDir, 'fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });
    sourceFilePath = path.join(fixtureDir, 'fallback.db');

    const client = new SqliteClient(sourceFilePath);
    await client.execAtomic(`
      CREATE TABLE clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL
      );
      INSERT INTO clientes (nombre) VALUES ('Acme Corp'), ('Beta LLC');
    `);
    await client.close();

    app = buildServer();

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'namespace-fallback@test.test', password: 'FallbackTest123!' },
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
      payload: { name: 'Namespace Fallback Project' },
    });
    assert.equal(projRes.statusCode, 201);
    projectId = JSON.parse(projRes.payload).project.id;
  });

  test.after(async () => {
    await ConnectionPool.getInstance().shutdown();
    if (app) await app.close();
    await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('auto mode falls back to a local SQLite file when sqld is down', async () => {
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/import-sqlite',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: {
        projectId,
        name: 'fallback-local',
        sourcePath: sourceFilePath,
      },
    });

    assert.equal(importRes.statusCode, 201, importRes.payload);
    const importBody = JSON.parse(importRes.payload);
    assert.equal(importBody.database.type, 'sqlite');
    assert.equal(importBody.database.metadata.runtime.provider, 'local-file');
    assert.equal(importBody.database.status, 'active');

    const schemaRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${importBody.database.id}/schema`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(schemaRes.statusCode, 200, schemaRes.payload);
    const schemaBody = JSON.parse(schemaRes.payload);
    const clientes = schemaBody.tables.find((table) => table.table === 'clientes');
    assert.ok(clientes, 'la tabla clientes debe existir');
    assert.equal(clientes.rowCount, 2);

    const queryRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${importBody.database.id}/query`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: { sql: 'SELECT * FROM clientes ORDER BY id' },
    });
    assert.equal(queryRes.statusCode, 200, queryRes.payload);
    const queryBody = JSON.parse(queryRes.payload);
    assert.equal(queryBody.ok, true);
    assert.equal(queryBody.rows.length, 2);
    assert.equal(queryBody.rows[0].nombre, 'Acme Corp');
  });

  test('strict namespace mode fails cleanly and does not create a database record', async () => {
    process.env.LIBSQL_NAMESPACE_IMPORTS = 'true';

    try {
      const importRes = await app.inject({
        method: 'POST',
        url: '/api/v1/databases/import-sqlite',
        headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
        payload: {
          projectId,
          name: 'strict-namespace',
          sourcePath: sourceFilePath,
        },
      });

      assert.equal(importRes.statusCode, 503, importRes.payload);
      const body = JSON.parse(importRes.payload);
      assert.match(body.error, /sqld no está disponible/i);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/databases?projectId=${projectId}`,
        headers: { cookie: cookieHeader },
      });
      assert.equal(listRes.statusCode, 200, listRes.payload);
      const listBody = JSON.parse(listRes.payload);
      const created = (listBody.databases || []).find((database) => database.name === 'strict-namespace');
      assert.equal(created, undefined, 'no debe quedar un registro roto');
    } finally {
      process.env.LIBSQL_NAMESPACE_IMPORTS = 'auto';
    }
  });

  test('convert-to-local repairs an existing sqld namespace record', async () => {
    const project = await AppDataSource.getRepository(Project).findOneByOrFail({ id: projectId });
    const subdomain = `legacy-namespace-${Date.now()}`;
    const namespacePath = path.join(
      process.env.SQLD_DATA_DIR,
      'data',
      'dbs',
      subdomain,
      'data',
    );

    fs.mkdirSync(path.dirname(namespacePath), { recursive: true });
    const sourceClient = new SqliteClient(namespacePath);
    await sourceClient.execAtomic(`
      CREATE TABLE productos (
        id INTEGER PRIMARY KEY,
        nombre TEXT NOT NULL
      );
      INSERT INTO productos (id, nombre) VALUES (1, 'Producto legacy');
    `);
    await sourceClient.close();

    const databaseRepo = AppDataSource.getRepository(Database);
    const legacyDatabase = await databaseRepo.save(databaseRepo.create({
      name: 'legacy-namespace-db',
      type: 'libsql',
      status: 'active',
      subdomain,
      url: `http://sqld:8080/dev/${subdomain}`,
      encryptedToken: encrypt('legacy-token'),
      metadata: {
        runtime: {
          provider: 'sqld-namespace',
          namespace: subdomain,
          connectionUrl: `http://sqld:8080/dev/${subdomain}`,
          internalUrl: `http://sqld:8080/dev/${subdomain}`,
          backendUrl: `http://sqld:8080/dev/${subdomain}`,
          publicUrl: `http://sqld:8080/dev/${subdomain}`,
          publicHost: 'localhost',
        },
      },
      project,
    }));

    const convertRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${legacyDatabase.id}/convert-to-local`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
    });

    assert.equal(convertRes.statusCode, 200, convertRes.payload);
    const convertBody = JSON.parse(convertRes.payload);
    assert.equal(convertBody.database.type, 'sqlite');
    assert.equal(convertBody.database.metadata.runtime.provider, 'local-file');
    assert.equal(convertBody.database.status, 'active');

    const schemaRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases/${legacyDatabase.id}/schema`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(schemaRes.statusCode, 200, schemaRes.payload);
    const schemaBody = JSON.parse(schemaRes.payload);
    const productos = schemaBody.tables.find((table) => table.table === 'productos');
    assert.ok(productos, 'la tabla productos debe existir después de la conversión');
    assert.equal(productos.rowCount, 1);

    const queryRes = await app.inject({
      method: 'POST',
      url: `/api/v1/databases/${legacyDatabase.id}/query`,
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: { sql: 'SELECT * FROM productos' },
    });
    assert.equal(queryRes.statusCode, 200, queryRes.payload);
    const queryBody = JSON.parse(queryRes.payload);
    assert.equal(queryBody.rows[0].nombre, 'Producto legacy');
  });
});

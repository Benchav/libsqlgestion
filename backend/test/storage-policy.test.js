const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated libSQL-first policy environment. Must be set before loading modules.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-storage-policy-'));
const testDbPath = path.join(tempDir, 'control.db');
const storageRoot = path.join(tempDir, 'storage');
const sqldDataDir = path.join(tempDir, 'sqld');
const missingDockerSocket = path.join(tempDir, 'missing-docker.sock');
const dummyDockerSocket = path.join(tempDir, 'dummy-docker.sock');
const sourceFilePath = path.join(tempDir, 'fixtures', 'source.db');

process.env.DATABASE_FILE = testDbPath;
process.env.SQLITE_STORAGE_ROOT = storageRoot;
process.env.SQLD_DATA_DIR = sqldDataDir;
process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PUBLIC_DOMAIN = 'data.example.com';
process.env.DATABASE_PUBLIC_PROTOCOL = 'https';
process.env.DATABASE_PUBLIC_BASE_URL = 'https://data.example.com';

process.env.LIBSQL_ADMIN_URL = 'http://127.0.0.1:1';
process.env.LIBSQL_ENABLE_NAMESPACES = 'true';
process.env.LIBSQL_NAMESPACE_PUBLIC_ENABLED = 'true';
process.env.LIBSQL_NAMESPACE_IMPORTS = 'auto';
process.env.LIBSQL_IMPORT_RUNTIME = 'false';
process.env.DOCKER_SOCKET_PATH = missingDockerSocket;
process.env.LIBSQL_REQUIRE_PRIMARY = 'true';
process.env.LIBSQL_ALLOW_LOCAL_FILE = 'false';
process.env.LIBSQL_PRIMARY_MODE = 'auto';
process.env.TRAEFIK_CERT_RESOLVER = '';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { ConnectionPool } = require('../dist/infrastructure/db/ConnectionPool');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { bootstrapPlatformSettings } = require('../dist/application/settings/PlatformSettingsService');
const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
const { DatabaseService } = require('../dist/application/databases/DatabaseService');
const { buildServer } = require('../dist/server');

test.describe('libSQL-first storage policy', () => {
  let app;
  let cookieHeader;
  let csrfToken;
  let projectId;

  test.before(async () => {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();
    await bootstrapPlatformSettings();

    fs.mkdirSync(path.dirname(sourceFilePath), { recursive: true });
    const sourceClient = new SqliteClient(sourceFilePath);
    await sourceClient.execAtomic(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO items (name) VALUES ('one'), ('two');
    `);
    await sourceClient.close();
    fs.writeFileSync(dummyDockerSocket, '');

    app = buildServer();

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'storage-policy@test.test', password: 'StoragePolicy123!' },
    });
    assert.equal(regRes.statusCode, 200, regRes.payload);

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
      payload: { name: 'Storage Policy Project' },
    });
    assert.equal(projRes.statusCode, 201, projRes.payload);
    projectId = JSON.parse(projRes.payload).project.id;
  });

  test.after(async () => {
    await ConnectionPool.getInstance().shutdown();
    if (app) await app.close();
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('reports no usable primary and no local fallback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/databases/storage-capabilities',
      headers: { cookie: cookieHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = JSON.parse(res.payload);
    assert.equal(body.namespace.enabled, true);
    assert.equal(body.namespace.publicEnabled, true);
    assert.equal(body.namespace.available, false);
    assert.equal(body.namespace.usable, false);
    assert.equal(body.runtime.available, false);
    assert.equal(body.local.allowed, false);
    assert.equal(body.requirePrimary, true);
    assert.equal(body.defaultMode, null);
  });

  test('refuses to create a libSQL database when no primary is available', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/databases',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: {
        projectId,
        name: 'no-primary',
        type: 'libsql',
        primaryMode: 'auto',
      },
    });

    assert.equal(res.statusCode, 503, res.payload);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /No libSQL primary/i);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/databases?projectId=${projectId}`,
      headers: { cookie: cookieHeader },
    });
    const list = JSON.parse(listRes.payload).databases || [];
    assert.equal(list.some((database) => database.name === 'no-primary'), false);
  });

  test('refuses LOCAL-FILE import when the policy disables it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/import-sqlite',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: {
        projectId,
        name: 'blocked-local',
        sourcePath: sourceFilePath,
        storageMode: 'local',
      },
    });

    assert.equal(res.statusCode, 403, res.payload);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /LOCAL-FILE/i);
  });

  test('auto import refuses LOCAL-FILE when no primary is available', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/import-sqlite',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: {
        projectId,
        name: 'blocked-auto',
        sourcePath: sourceFilePath,
        storageMode: 'auto',
      },
    });

    assert.equal(res.statusCode, 503, res.payload);
  });

  test('explicit namespace import fails clearly when sqld is down', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/import-sqlite',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: {
        projectId,
        name: 'namespace-down',
        sourcePath: sourceFilePath,
        subdomain: 'namespace-down',
        storageMode: 'namespace',
      },
    });

    assert.equal(res.statusCode, 503, res.payload);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /sqld/i);
  });

  test('local escape hatch imports when explicitly enabled', async () => {
    process.env.LIBSQL_ALLOW_LOCAL_FILE = 'true';
    process.env.LIBSQL_REQUIRE_PRIMARY = 'false';

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/databases/import-sqlite',
        headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
        payload: {
          projectId,
          name: 'legacy-local',
          sourcePath: sourceFilePath,
          storageMode: 'local',
        },
      });

      assert.equal(res.statusCode, 201, res.payload);
      const body = JSON.parse(res.payload);
      assert.equal(body.database.type, 'sqlite');
      assert.equal(body.database.runtimeProvider, 'local-file');
      assert.equal(body.database.syncUrl, '');
    } finally {
      process.env.LIBSQL_ALLOW_LOCAL_FILE = 'false';
      process.env.LIBSQL_REQUIRE_PRIMARY = 'true';
    }
  });

  test('runtime becomes the default primary when the Docker socket exists', async () => {
    process.env.LIBSQL_ENABLE_NAMESPACES = 'false';
    process.env.LIBSQL_ADMIN_URL = '';
    process.env.DOCKER_SOCKET_PATH = dummyDockerSocket;
    process.env.LIBSQL_REQUIRE_PRIMARY = 'true';
    process.env.LIBSQL_ALLOW_LOCAL_FILE = 'false';

    try {
      const service = new DatabaseService();
      const capabilities = await service.getStorageCapabilities();
      assert.equal(capabilities.runtime.available, true);
      assert.equal(capabilities.namespace.usable, false);
      assert.equal(capabilities.local.allowed, false);
      assert.equal(capabilities.defaultMode, 'runtime');
    } finally {
      process.env.LIBSQL_ENABLE_NAMESPACES = 'true';
      process.env.LIBSQL_ADMIN_URL = 'http://127.0.0.1:1';
      process.env.DOCKER_SOCKET_PATH = missingDockerSocket;
    }
  });
});

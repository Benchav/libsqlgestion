const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated environment BEFORE loading compiled modules
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-import-e2e-'));
const testDbPath = path.join(tempDir, 'control.db');
const storageRoot = path.join(tempDir, 'storage');

process.env.DATABASE_FILE = testDbPath;
process.env.SQLITE_STORAGE_ROOT = storageRoot;
process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { ConnectionPool } = require('../dist/infrastructure/db/ConnectionPool');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { SqliteClient } = require('../dist/infrastructure/sqlite/SqliteClient');
const { buildServer } = require('../dist/server');

test.describe('Import → Schema → Query End-to-End Integration', () => {
  let app;
  let cookieHeader;
  let csrfToken;
  let apiProjectId;
  let apiDbId;
  let sourceFilePath;

  test.before(async () => {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();

    // ── Build a SQLite file with known tables and real data ──
    const sourceDbDir = path.join(tempDir, 'fixtures');
    fs.mkdirSync(sourceDbDir, { recursive: true });
    sourceFilePath = path.join(sourceDbDir, 'erp-demo.db');

    const client = new SqliteClient(sourceFilePath);
    await client.execAtomic(`
      CREATE TABLE clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        email TEXT,
        activo INTEGER DEFAULT 1
      );

      INSERT INTO clientes (nombre, email, activo) VALUES
        ('Acme Corp', 'info@acme.test', 1),
        ('Beta LLC', 'hola@beta.test', 1),
        ('Gamma SA', NULL, 0);

      CREATE TABLE facturas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER REFERENCES clientes(id),
        total REAL NOT NULL,
        moneda TEXT DEFAULT 'USD',
        emitida TEXT
      );

      INSERT INTO facturas (cliente_id, total, moneda, emitida) VALUES
        (1, 1500.00, 'USD', '2025-03-15'),
        (1,  320.50, 'USD', '2025-04-01'),
        (2, 7800.99, 'EUR', '2025-02-10'),
        (3,   10.00, 'USD', '2025-06-01');

      CREATE VIEW clientes_activos AS
        SELECT id, nombre, email FROM clientes WHERE activo = 1;

      CREATE TABLE sin_datos (x INTEGER);
    `);
    await client.close();

    // ── Boot Fastify server ──
    app = buildServer();

    // ── Register & login via API ──
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'import-tester@test.test', password: 'Imp0rtTest123!' },
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

    // ── Create project ──
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: { name: 'Import E2E Project' },
    });
    assert.equal(projRes.statusCode, 201);
    apiProjectId = JSON.parse(projRes.payload).project.id;

    // ── Import the SQLite file via API ──
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/databases/import-sqlite',
      headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
      payload: {
        projectId: apiProjectId,
        name: 'erp-importado',
        sourcePath: sourceFilePath,
      },
    });
    assert.equal(importRes.statusCode, 201);
    const importData = JSON.parse(importRes.payload);
    assert.ok(importData.database);
    assert.ok(importData.database.id);
    apiDbId = importData.database.id;
  });

  test.after(async () => {
    if (apiDbId) ConnectionPool.getInstance().evict(apiDbId);
    await ConnectionPool.getInstance().shutdown();
    if (app) await app.close();
    await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────
  // Suite 1 ─ Schema endpoint
  // ──────────────────────────────────────────────────────────
  test.describe('GET /databases/:id/schema', () => {
    test('returns tables with columns, rowCount, and foreignKeys', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/databases/${apiDbId}/schema`,
        headers: { cookie: cookieHeader },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.tables));
      assert.ok(Array.isArray(body.views));

      // Find each expected table
      const clientes = body.tables.find((t) => t.table === 'clientes');
      const facturas = body.tables.find((t) => t.table === 'facturas');
      const sinDatos = body.tables.find((t) => t.table === 'sin_datos');

      assert.ok(clientes, 'tabla clientes debe existir');
      assert.ok(facturas, 'tabla facturas debe existir');
      assert.ok(sinDatos, 'tabla sin_datos debe existir');

      // ── clientes ──
      assert.equal(clientes.kind, 'table');
      assert.equal(clientes.rowCount, 3);
      assert.ok(Array.isArray(clientes.columns), 'clientes.columns debe ser array');
      assert.ok(clientes.columns.length >= 4, 'clientes debe tener al menos 4 columnas');

      const colNombres = clientes.columns.map((c) => c.name);
      assert.ok(colNombres.includes('nombre'));
      assert.ok(colNombres.includes('email'));
      assert.ok(colNombres.includes('activo'));
      assert.ok(colNombres.includes('id'));

      // ── facturas ──
      assert.equal(facturas.rowCount, 4);
      assert.ok(facturas.columns.length >= 5);
      const facCols = facturas.columns.map((c) => c.name);
      assert.ok(facCols.includes('total'));
      assert.ok(facCols.includes('cliente_id'));
      assert.ok(facCols.includes('moneda'));

      // ── foreign keys ──
      assert.ok(Array.isArray(facturas.foreignKeys));
      const fk = facturas.foreignKeys.find((k) => k.from === 'cliente_id');
      assert.ok(fk, 'facturas.cliente_id debe tener FK');
      assert.equal(fk.table, 'clientes');

      // ── sin_datos ──
      assert.equal(sinDatos.rowCount, 0);

      // ── views ──
      const vista = body.views.find((v) => v.table === 'clientes_activos');
      assert.ok(vista, 'view clientes_activos debe existir');
      assert.equal(vista.kind, 'view');
    });
  });

  // ──────────────────────────────────────────────────────────
  // Suite 2 ─ Query endpoint ─ SELECT real data
  // ──────────────────────────────────────────────────────────
  test.describe('POST /databases/:id/query', () => {
    function queryHeaders() {
      return { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken };
    }

    test('SELECT * FROM clientes returns 3 rows with real values', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/databases/${apiDbId}/query`,
        headers: queryHeaders(),
        payload: { sql: 'SELECT * FROM clientes ORDER BY id' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.rows));
      assert.equal(body.rows.length, 3);

      assert.equal(body.rows[0].nombre, 'Acme Corp');
      assert.equal(body.rows[0].email, 'info@acme.test');
      assert.equal(body.rows[1].nombre, 'Beta LLC');
      assert.equal(body.rows[2].nombre, 'Gamma SA');
      assert.equal(body.rows[2].email, null);
      assert.equal(body.rows[2].activo, 0);
    });

    test('SELECT COUNT(*) FROM facturas returns 4', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/databases/${apiDbId}/query`,
        headers: queryHeaders(),
        payload: { sql: 'SELECT COUNT(*) as cnt FROM facturas' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.ok(body.rows.length >= 1);
      assert.equal(body.rows[0].cnt, 4);
    });

    test('SELECT with JOIN returns correct data', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/databases/${apiDbId}/query`,
        headers: queryHeaders(),
        payload: {
          sql: `SELECT c.nombre, f.total
                FROM clientes c
                JOIN facturas f ON f.cliente_id = c.id
                ORDER BY f.total DESC`,
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.equal(body.rows.length, 4);
      assert.equal(body.rows[0].nombre, 'Beta LLC');
      assert.equal(body.rows[0].total, 7800.99);
      assert.equal(body.rows[3].nombre, 'Gamma SA');
      assert.equal(body.rows[3].total, 10);
    });

    test('SELECT from empty table returns empty rows array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/databases/${apiDbId}/query`,
        headers: queryHeaders(),
        payload: { sql: 'SELECT * FROM sin_datos' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.rows));
      assert.equal(body.rows.length, 0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Suite 3 ─ Studio simulation (exact calls the UI makes)
  // ──────────────────────────────────────────────────────────
  test.describe('Studio simulation', () => {
    function queryHeaders() {
      return { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken };
    }

    test('simulates the Studio flow: schema → COUNT → SELECT * with LIMIT', async () => {
      // 1. Schema (like the Studio sidebar)
      const schemaRes = await app.inject({
        method: 'GET',
        url: `/api/v1/databases/${apiDbId}/schema`,
        headers: { cookie: cookieHeader },
      });
      assert.equal(schemaRes.statusCode, 200);
      const schemaBody = JSON.parse(schemaRes.payload);
      const clientesSchema = schemaBody.tables.find((t) => t.table === 'clientes');
      assert.ok(clientesSchema);
      assert.equal(clientesSchema.rowCount, 3);

      // 2. COUNT (like the DataGrid totalRows)
      const countRes = await app.inject({
        method: 'POST',
        url: `/api/v1/databases/${apiDbId}/query`,
        headers: queryHeaders(),
        payload: { sql: 'SELECT COUNT(*) as cnt FROM "clientes"' },
      });
      assert.equal(countRes.statusCode, 200);
      const countBody = JSON.parse(countRes.payload);
      assert.equal(countBody.ok, true);
      assert.equal(countBody.rows[0].cnt, 3);

      // 3. SELECT * with LIMIT/OFFSET (like the DataGrid)
      const dataRes = await app.inject({
        method: 'POST',
        url: `/api/v1/databases/${apiDbId}/query`,
        headers: queryHeaders(),
        payload: { sql: 'SELECT * FROM "clientes" ORDER BY "id" ASC LIMIT 50 OFFSET 0' },
      });
      assert.equal(dataRes.statusCode, 200);
      const dataBody = JSON.parse(dataRes.payload);
      assert.equal(dataBody.ok, true);
      assert.equal(dataBody.rows.length, 3);

      const nombres = dataBody.rows.map((r) => r.nombre);
      assert.deepEqual(nombres, ['Acme Corp', 'Beta LLC', 'Gamma SA']);
    });
  });

  test.describe('Import from live WAL database', () => {
    test('imports a consistent snapshot while the source database is still open in WAL mode', async () => {
      const liveWalPath = path.join(tempDir, 'fixtures', 'live-wal.db');
      const liveClient = new SqliteClient(liveWalPath);

      try {
        await liveClient.execAtomic(`
          CREATE TABLE pedidos (
            id INTEGER PRIMARY KEY,
            descripcion TEXT NOT NULL
          );
          INSERT INTO pedidos (id, descripcion) VALUES (1, 'pedido abierto');
          INSERT INTO pedidos (id, descripcion) VALUES (2, 'pedido en wal');
        `);

        const walPath = `${liveWalPath}-wal`;
        assert.ok(fs.existsSync(walPath), 'debe existir archivo WAL para este escenario');

        const importRes = await app.inject({
          method: 'POST',
          url: '/api/v1/databases/import-sqlite',
          headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
          payload: {
            projectId: apiProjectId,
            name: 'wal-importado',
            sourcePath: liveWalPath,
          },
        });

        assert.equal(importRes.statusCode, 201);
        const importBody = JSON.parse(importRes.payload);
        const walDbId = importBody.database.id;

        const schemaRes = await app.inject({
          method: 'GET',
          url: `/api/v1/databases/${walDbId}/schema`,
          headers: { cookie: cookieHeader },
        });
        assert.equal(schemaRes.statusCode, 200);
        const schemaBody = JSON.parse(schemaRes.payload);
        const pedidos = schemaBody.tables.find((t) => t.table === 'pedidos');
        assert.ok(pedidos, 'la tabla pedidos debe existir tras importar desde WAL');
        assert.equal(pedidos.rowCount, 2);

        const queryRes = await app.inject({
          method: 'POST',
          url: `/api/v1/databases/${walDbId}/query`,
          headers: { cookie: cookieHeader, 'x-csrf-token-v2': csrfToken },
          payload: { sql: 'SELECT * FROM pedidos ORDER BY id' },
        });
        assert.equal(queryRes.statusCode, 200);
        const queryBody = JSON.parse(queryRes.payload);
        assert.equal(queryBody.ok, true);
        assert.equal(queryBody.rows.length, 2);
        assert.equal(queryBody.rows[0].descripcion, 'pedido abierto');
        assert.equal(queryBody.rows[1].descripcion, 'pedido en wal');
      } finally {
        await liveClient.close();
      }
    });
  });
});

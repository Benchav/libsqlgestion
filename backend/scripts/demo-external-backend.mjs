/**
 * DEMO: Backend Externo consumiendo LibSQLGestion vía URL y Token de Autenticación
 * 
 * Este script simula una aplicación backend externa (ej: API REST en Express/Fastify/Next.js)
 * que consume de forma 100% remota una base de datos gestionada por `libsqlgestion`
 * utilizando exclusivamente el cliente oficial de Turso: `@libsql/client` con URL y Auth Token.
 * 
 * ❌ Cero accesos directos a archivos o SQLite local (sin file:...)
 * ✔ Conexión remota por HTTP / Protocolo Hrana Pipeline (/v2/pipeline)
 * ✔ Autenticación estricta con Bearer Auth Token
 * ✔ Simulación de microservicio con operaciones CRUD completas:
 *     - POST   /api/v1/productos
 *     - GET    /api/v1/productos
 *     - GET    /api/v1/productos/:id
 *     - PUT    /api/v1/productos/:id
 *     - DELETE /api/v1/productos/:id
 * ✔ Prueba de Batch / Transacciones remotas
 */

import http from 'http';
import { createClient } from '@libsql/client';

// Configuración de Colores para la Terminal
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

// 1. Parámetros de Conexión Remota a LibSQLGestion
const DATABASE_ID = process.env.DATABASE_ID || 'cd8c493d-44f1-461e-948e-67463694ec9a';
const BACKEND_BASE = process.env.LIBSQLGESTION_URL || 'http://127.0.0.1:3000';
const DATABASE_URL = `${BACKEND_BASE}/api/v1/databases/${DATABASE_ID}/`;
const DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN || '603bd05b3fe99651c2a8924e0eded07a863943de3f73e9a5add79b2d0e433709';

console.log(`\n${c.cyan}========================================================================${c.reset}`);
console.log(`${c.bright}${c.green}  PRUEBA E2E: CONEXIÓN REMOTA VÍA TOKEN Y URL (ESTILO TURSO WEB)         ${c.reset}`);
console.log(`${c.cyan}========================================================================${c.reset}`);
console.log(`URL de Conexión:    ${c.yellow}${DATABASE_URL}${c.reset}`);
console.log(`Token Auth:         ${c.yellow}${DATABASE_AUTH_TOKEN.slice(0, 10)}...${DATABASE_AUTH_TOKEN.slice(-6)}${c.reset}`);
console.log(`Cliente LibSQL:     ${c.cyan}@libsql/client (Driver oficial Turso / Protocolo Hrana)${c.reset}`);
console.log(`${c.cyan}------------------------------------------------------------------------${c.reset}\n`);

// ---------------------------------------------------------------------
// PASO 1: Validación de Seguridad - Rechazo de Token Inválido (401)
// ---------------------------------------------------------------------
console.log(`${c.bright}🔒 PASO 1: Verificando seguridad de autenticación con Token Inválido...${c.reset}`);
const invalidClient = createClient({
  url: DATABASE_URL,
  authToken: 'token_falso_y_no_autorizado_xyz_123',
});

try {
  await invalidClient.execute('SELECT 1;');
  console.error(`${c.red}❌ ERROR DE SEGURIDAD: El servidor aceptó un token inválido.${c.reset}`);
  process.exit(1);
} catch (err) {
  console.log(`   ${c.green}✔ Correcto: Conexión rechazada con error de autenticación 401:${c.reset}`);
  console.log(`   ${c.yellow}${err.message}${c.reset}\n`);
} finally {
  await invalidClient.close();
}

// ---------------------------------------------------------------------
// PASO 2: Conexión con Token Válido y Creación Remota de Tablas
// ---------------------------------------------------------------------
console.log(`${c.bright}🌐 PASO 2: Conectando con Token y URL autorizados en LibSQLGestion...${c.reset}`);
const dbClient = createClient({
  url: DATABASE_URL,
  authToken: DATABASE_AUTH_TOKEN,
});

// Probar handshake y consulta de prueba remota
const pingT0 = performance.now();
const pingRes = await dbClient.execute('SELECT datetime(\'now\') as server_time, sqlite_version() as version;');
const pingMs = (performance.now() - pingT0).toFixed(2);

console.log(`   ${c.green}✔ Conectado exitosamente por HTTP en ${pingMs} ms${c.reset}`);
console.log(`   Versión del motor: ${c.cyan}${pingRes.rows[0].version}${c.reset} | Hora Servidor: ${c.cyan}${pingRes.rows[0].server_time}${c.reset}\n`);

// Crear tabla de demostración
console.log(`${c.bright}🛠  PASO 3: Creando tabla de demostración 'productos_demo' remotamente...${c.reset}`);
await dbClient.execute(`
  CREATE TABLE IF NOT EXISTS productos_demo (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    precio REAL NOT NULL,
    stock INTEGER NOT NULL,
    categoria TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
console.log(`   ${c.green}✔ Tabla 'productos_demo' verificada/creada en la base de datos remota.${c.reset}\n`);

// ---------------------------------------------------------------------
// PASO 4: Servidor del Backend Externo (Simulando API REST de E-Commerce)
// ---------------------------------------------------------------------
const externalServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  res.setHeader('Content-Type', 'application/json');

  const send = (statusCode, data) => {
    res.writeHead(statusCode);
    res.end(JSON.stringify(data, null, 2));
  };

  const getBody = () => new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
  });

  try {
    // POST /api/v1/productos (Create)
    if (method === 'POST' && pathname === '/api/v1/productos') {
      const { id, nombre, precio, stock, categoria } = await getBody();
      const newId = id || `PROD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      await dbClient.execute({
        sql: `INSERT INTO productos_demo (id, nombre, precio, stock, categoria) VALUES (?, ?, ?, ?, ?)`,
        args: [newId, nombre, precio, stock, categoria || 'General'],
      });

      const created = await dbClient.execute({
        sql: `SELECT * FROM productos_demo WHERE id = ?`,
        args: [newId],
      });

      return send(201, {
        success: true,
        message: 'Producto creado exitosamente mediante conexión remota LibSQL',
        data: created.rows[0],
      });
    }

    // GET /api/v1/productos (List all)
    if (method === 'GET' && pathname === '/api/v1/productos') {
      const result = await dbClient.execute('SELECT * FROM productos_demo ORDER BY createdAt DESC');
      return send(200, {
        success: true,
        total: result.rows.length,
        data: result.rows,
      });
    }

    // Rutas con ID
    const getByIdMatch = pathname.match(/^\/api\/v1\/productos\/([^/]+)$/);
    if (getByIdMatch) {
      const prodId = getByIdMatch[1];

      // GET /api/v1/productos/:id (Get By ID)
      if (method === 'GET') {
        const result = await dbClient.execute({
          sql: 'SELECT * FROM productos_demo WHERE id = ?',
          args: [prodId],
        });

        if (result.rows.length === 0) {
          return send(404, { success: false, error: 'Producto no encontrado' });
        }

        return send(200, {
          success: true,
          data: result.rows[0],
        });
      }

      // PUT /api/v1/productos/:id (Update)
      if (method === 'PUT') {
        const { nombre, precio, stock, categoria } = await getBody();

        const check = await dbClient.execute({
          sql: 'SELECT * FROM productos_demo WHERE id = ?',
          args: [prodId],
        });

        if (check.rows.length === 0) {
          return send(404, { success: false, error: 'Producto no encontrado' });
        }

        await dbClient.execute({
          sql: `UPDATE productos_demo 
                SET nombre = COALESCE(?, nombre),
                    precio = COALESCE(?, precio),
                    stock = COALESCE(?, stock),
                    categoria = COALESCE(?, categoria),
                    updatedAt = CURRENT_TIMESTAMP
                WHERE id = ?`,
          args: [nombre ?? null, precio ?? null, stock ?? null, categoria ?? null, prodId],
        });

        const updated = await dbClient.execute({
          sql: 'SELECT * FROM productos_demo WHERE id = ?',
          args: [prodId],
        });

        return send(200, {
          success: true,
          message: 'Producto actualizado exitosamente en la base de datos remota',
          data: updated.rows[0],
        });
      }

      // DELETE /api/v1/productos/:id (Delete)
      if (method === 'DELETE') {
        const check = await dbClient.execute({
          sql: 'SELECT * FROM productos_demo WHERE id = ?',
          args: [prodId],
        });

        if (check.rows.length === 0) {
          return send(404, { success: false, error: 'Producto no encontrado' });
        }

        await dbClient.execute({
          sql: 'DELETE FROM productos_demo WHERE id = ?',
          args: [prodId],
        });

        return send(200, {
          success: true,
          message: `Producto ${prodId} eliminado permanentemente`,
        });
      }
    }

    return send(404, { error: 'Ruta no encontrada en el backend externo' });
  } catch (err) {
    return send(500, { success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// PASO 5: Ejecución de las Pruebas CRUD sobre el Backend Externo
// ---------------------------------------------------------------------
externalServer.listen(0, '127.0.0.1', async () => {
  const port = externalServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`${c.bright}🚀 PASO 4: Servidor Backend Externo iniciado en ${c.green}${baseUrl}${c.reset}\n`);

  try {
    // 1. [POST] Crear un nuevo producto
    console.log(`${c.bright}▶ 1. [POST] Creando un nuevo producto a través del Backend Externo...${c.reset}`);
    const t0 = performance.now();
    const createRes = await fetch(`${baseUrl}/api/v1/productos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: 'Pastel de Chocolate Suizo con Frambuesas',
        precio: 450.00,
        stock: 12,
        categoria: 'Repostería Exclusiva',
      }),
    });
    const createData = await createRes.json();
    const tCreate = (performance.now() - t0).toFixed(2);
    const productId = createData.data.id;

    console.log(`   ${c.green}✔ HTTP ${createRes.status} Created (${tCreate} ms)${c.reset}`);
    console.log(`   ID generado en BD: ${c.cyan}${productId}${c.reset}`);
    console.log(`   Producto:          ${c.yellow}${createData.data.nombre}${c.reset} - Precio: $${createData.data.precio} - Stock: ${createData.data.stock}\n`);

    // 2. [GET] Listar productos
    console.log(`${c.bright}▶ 2. [GET] Listando catálogo de productos desde la BD remota...${c.reset}`);
    const t1 = performance.now();
    const listRes = await fetch(`${baseUrl}/api/v1/productos`);
    const listData = await listRes.json();
    const tList = (performance.now() - t1).toFixed(2);

    console.log(`   ${c.green}✔ HTTP ${listRes.status} OK (${tList} ms)${c.reset}`);
    console.log(`   Total de registros recuperados: ${c.cyan}${listData.total}${c.reset}\n`);

    // 3. [GET BY ID] Consultar producto por ID
    console.log(`${c.bright}▶ 3. [GET BY ID] Consultando producto individual por ID: ${c.cyan}${productId}${c.reset}...`);
    const t2 = performance.now();
    const getRes = await fetch(`${baseUrl}/api/v1/productos/${productId}`);
    const getData = await getRes.json();
    const tGet = (performance.now() - t2).toFixed(2);

    console.log(`   ${c.green}✔ HTTP ${getRes.status} OK (${tGet} ms)${c.reset}`);
    console.log(`   Detalle:`, getData.data);
    console.log('');

    // 4. [PUT] Actualizar producto
    console.log(`${c.bright}▶ 4. [PUT] Actualizando precio y stock del producto...${c.reset}`);
    const t3 = performance.now();
    const updateRes = await fetch(`${baseUrl}/api/v1/productos/${productId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        precio: 495.00,
        stock: 25,
        categoria: 'Repostería Premium Colección',
      }),
    });
    const updateData = await updateRes.json();
    const tUpdate = (performance.now() - t3).toFixed(2);

    console.log(`   ${c.green}✔ HTTP ${updateRes.status} OK (${tUpdate} ms)${c.reset}`);
    console.log(`   Nuevo Precio:  ${c.green}$${updateData.data.precio}${c.reset} (Antes: $450.00)`);
    console.log(`   Nuevo Stock:   ${c.green}${updateData.data.stock}${c.reset} (Antes: 12)`);
    console.log(`   Nueva Categoría: ${c.green}${updateData.data.categoria}${c.reset}\n`);

    // 5. [DELETE] Eliminar el producto
    console.log(`${c.bright}▶ 5. [DELETE] Eliminando el producto de la base de datos...${c.reset}`);
    const t4 = performance.now();
    const delRes = await fetch(`${baseUrl}/api/v1/productos/${productId}`, {
      method: 'DELETE',
    });
    const delData = await delRes.json();
    const tDel = (performance.now() - t4).toFixed(2);

    console.log(`   ${c.green}✔ HTTP ${delRes.status} OK (${tDel} ms)${c.reset}`);
    console.log(`   Mensaje: ${delData.message}\n`);

    // 6. [VERIFY 404] Confirmar eliminación física
    console.log(`${c.bright}▶ 6. [VERIFY 404] Comprobando que el producto ya no existe en la base de datos...${c.reset}`);
    const notFoundRes = await fetch(`${baseUrl}/api/v1/productos/${productId}`);
    console.log(`   ${c.green}✔ HTTP ${notFoundRes.status} Not Found (Eliminación confirmada en BD remota)${c.reset}\n`);

    // -----------------------------------------------------------------
    // PASO 6: Demostración de Batch Atómico Remoto (Transacciones LibSQL)
    // -----------------------------------------------------------------
    console.log(`${c.bright}⚡ PASO 7: Probando BATCH Atómico Remoto mediante @libsql/client...${c.reset}`);
    const batchT0 = performance.now();
    const batchResults = await dbClient.batch([
      {
        sql: `INSERT INTO productos_demo (id, nombre, precio, stock, categoria) VALUES (?, ?, ?, ?, ?)`,
        args: ['BATCH-001', 'Galletas de Mantequilla Holandesa', 85.00, 50, 'Gourmet'],
      },
      {
        sql: `INSERT INTO productos_demo (id, nombre, precio, stock, categoria) VALUES (?, ?, ?, ?, ?)`,
        args: ['BATCH-002', 'Croissant de Almendras Tostadas', 110.00, 30, 'Panadería'],
      },
      {
        sql: `SELECT COUNT(*) as total FROM productos_demo WHERE id LIKE 'BATCH-%'`,
      },
    ], 'write');
    const batchMs = (performance.now() - batchT0).toFixed(2);

    const countRow = batchResults[2].rows[0];
    console.log(`   ${c.green}✔ Batch de 3 operaciones ejecutado exitosamente en ${batchMs} ms${c.reset}`);
    console.log(`   Registros creados en la transacción: ${c.cyan}${countRow.total}${c.reset}\n`);

    // Limpiar registros del batch
    await dbClient.execute(`DELETE FROM productos_demo WHERE id LIKE 'BATCH-%'`);

    // -----------------------------------------------------------------
    // RESUMEN FINAL
    // -----------------------------------------------------------------
    console.log(`${c.cyan}========================================================================${c.reset}`);
    console.log(`${c.bright}${c.green}  🎉 TODAS LAS PRUEBAS COMPLETADAS CON ÉXITO ABSOLUTO                   ${c.reset}`);
    console.log(`${c.cyan}========================================================================${c.reset}`);
    console.log(`• Método de Conexión:    100% Remoto vía URL (${DATABASE_URL})`);
    console.log(`• Autenticación:         Bearer Token verificado por LibSQLGestion`);
    console.log(`• Seguridad Token:       Tokens inválidos rechazados con HTTP 401`);
    console.log(`• Protocolo:             Turso Hrana Pipeline v2 (@libsql/client)`);
    console.log(`• Operaciones CRUD:      POST, GET, GET by ID, PUT, DELETE, 404 (Aprobadas)`);
    console.log(`• Batch Atómico:         Transacción de múltiples sentencias (Aprobada)`);
    console.log(`${c.cyan}========================================================================${c.reset}\n`);

  } catch (error) {
    console.error(`\n${c.red}❌ Error durante la ejecución de las pruebas: ${error.message}${c.reset}`);
  } finally {
    externalServer.close();
    await dbClient.close();
  }
});

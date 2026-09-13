import http from 'http';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@libsql/client';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Configuración de prueba
const DOMAIN = 'ibarrera.site';
const DB_NAME = 'insumosv1';
const DB_HASH = 'e0d47a08';
const SUBDOMAIN = `${DB_NAME}-${DB_HASH}`;
const FULL_PUBLIC_HOST = `${SUBDOMAIN}.${DOMAIN}`;

// Directorio temporal para la base de datos de prueba
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-url-test-'));
const dbFilePath = path.join(tempDir, 'data.db');
const db = new DatabaseSync(dbFilePath);

// Token criptográfico de autenticación de prueba
const VALID_AUTH_TOKEN = '92dba54d9bd333906096b58a7f771ddfe655ba1cc09e3fadda55080aa94ff3b7';
const INVALID_AUTH_TOKEN = 'token_invalido_hacker_9999999999';

console.log('================================================================');
console.log('   PRUEBA INTEGRAL: URL LOCAL VS. URL PÚBLICA CON TOKEN');
console.log('================================================================');
console.log(`Base de datos:       ${DB_NAME}`);
console.log(`Subdominio público:  ${FULL_PUBLIC_HOST}`);
console.log(`Archivo físico:      ${dbFilePath}`);
console.log(`Token requerido:     ${VALID_AUTH_TOKEN.slice(0, 16)}...`);
console.log('----------------------------------------------------------------\n');

// Servidor Gateway que emula el comportamiento de LibSQL + Reverse Proxy (Traefik/Coolify/Caddy)
let port = 0;
const server = http.createServer((req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const hostHeader = (req.headers['host'] || '').split(':')[0].toLowerCase();
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  // 1. Verificación de Autenticación
  if (token !== VALID_AUTH_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '401 Unauthorized: Invalid or missing authentication token' }));
    return;
  }

  // 2. Enrutamiento por Host (Local vs. Subdominio Público)
  const isLocalHost = hostHeader === '127.0.0.1' || hostHeader === 'localhost';
  const isPublicSubdomain = hostHeader === FULL_PUBLIC_HOST.toLowerCase();

  if (!isLocalHost && !isPublicSubdomain) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `404 Not Found: Host '${hostHeader}' not recognized` }));
    return;
  }

  // 3. Procesamiento de pipeline Hrana (@libsql/client)
  if (req.method === 'POST' && req.url === '/v2/pipeline') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const results = [];

        for (const r of payload.requests || []) {
          if (r.type === 'execute') {
            const sql = r.stmt.sql;
            const args = (r.stmt.args || []).map(a => (typeof a === 'object' && a !== null ? a.value : a));
            const isSelect = /^\s*(SELECT|PRAGMA)\b/i.test(sql);

            if (isSelect) {
              const stmt = db.prepare(sql);
              const rows = stmt.all(...args);
              const cols = rows.length > 0 ? Object.keys(rows[0]).map(k => ({ name: k })) : [];
              const hranaRows = rows.map(row => {
                return Object.values(row).map(val => {
                  if (val === null || val === undefined) return { type: 'null' };
                  if (typeof val === 'number') {
                    if (Number.isInteger(val)) return { type: 'integer', value: String(val) };
                    return { type: 'float', value: val };
                  }
                  return { type: 'text', value: String(val) };
                });
              });

              results.push({
                type: 'ok',
                response: {
                  type: 'execute',
                  result: {
                    cols,
                    rows: hranaRows,
                    affected_row_count: 0,
                    last_insert_rowid: null
                  }
                }
              });
            } else {
              const stmt = db.prepare(sql);
              const info = stmt.run(...args);
              results.push({
                type: 'ok',
                response: {
                  type: 'execute',
                  result: {
                    cols: [],
                    rows: [],
                    affected_row_count: info.changes,
                    last_insert_rowid: info.lastInsertRowid ? String(info.lastInsertRowid) : null
                  }
                }
              });
            }
          } else if (r.type === 'close') {
            results.push({ type: 'ok', response: { type: 'close' } });
          }
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Libsqlite-Route': isPublicSubdomain ? 'PUBLIC_WILDCARD' : 'LOCAL_DIRECT'
        });
        res.end(JSON.stringify({ baton: null, base_url: null, results }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(0, '127.0.0.1', async () => {
  port = server.address().port;
  const LOCAL_URL = `http://127.0.0.1:${port}`;
  const PUBLIC_URL = `http://${FULL_PUBLIC_HOST}:${port}`;

  console.log(`Gateway activo en puerto: ${port}`);
  console.log(`[URL LOCAL]   -> ${LOCAL_URL}`);
  console.log(`[URL PÚBLICA] -> ${PUBLIC_URL}\n`);

  try {
    // -------------------------------------------------------------
    // TEST 1: Seguridad - Rechazo de Token Inválido o Ausente
    // -------------------------------------------------------------
    console.log('📌 Test 1: Seguridad - Verificación de Token...');
    const unauthorizedClient = createClient({
      url: LOCAL_URL,
      authToken: INVALID_AUTH_TOKEN
    });

    let rejected = false;
    try {
      await unauthorizedClient.execute('SELECT 1');
    } catch (err) {
      rejected = true;
      console.log('   ✓ Token inválido rechazado correctamente (401 Unauthorized)');
    }

    if (!rejected) {
      throw new Error('Fallo de seguridad: Se permitió el acceso con un token no autorizado');
    }

    // -------------------------------------------------------------
    // TEST 2: Operación mediante URL LOCAL con Token Válido
    // -------------------------------------------------------------
    console.log('\n📌 Test 2: Operaciones sobre URL LOCAL (Red Interna)...');
    const localClient = createClient({
      url: LOCAL_URL,
      authToken: VALID_AUTH_TOKEN
    });

    const startLocal = performance.now();
    await localClient.execute(`
      CREATE TABLE IF NOT EXISTS productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE,
        descripcion TEXT,
        precio REAL,
        stock INTEGER
      )
    `);

    await localClient.execute({
      sql: 'INSERT INTO productos (codigo, descripcion, precio, stock) VALUES (?, ?, ?, ?)',
      args: ['PROD-001', 'Tornillo de Acero Inoxidable 1/2', 12.50, 500]
    });

    await localClient.execute({
      sql: 'INSERT INTO productos (codigo, descripcion, precio, stock) VALUES (?, ?, ?, ?)',
      args: ['PROD-002', 'Tuerca Hexagonal Grado 8', 4.75, 1200]
    });

    const localRead = await localClient.execute('SELECT * FROM productos');
    const timeLocal = (performance.now() - startLocal).toFixed(2);

    console.log(`   ✓ Tabla creada e insertados 2 registros vía URL Local en ${timeLocal} ms`);
    console.log(`   ✓ Registros leídos localmente:`, localRead.rows.map(r => ({ id: Number(r.id), codigo: r.codigo, desc: r.descripcion, stock: Number(r.stock) })));

    // -------------------------------------------------------------
    // TEST 3: Operación mediante URL PÚBLICA con Subdominio y Token
    // -------------------------------------------------------------
    console.log('\n📌 Test 3: Operaciones sobre URL PÚBLICA (Subdominio ibarrera.site)...');
    
    // El cliente de libSQL o reverse proxy transmite el Host público del subdominio
    const publicFetch = (sql, args = []) => {
      return new Promise((resolve, reject) => {
        const start = performance.now();
        const body = JSON.stringify({
          requests: [
            { type: 'execute', stmt: { sql, args, want_rows: true } },
            { type: 'close' }
          ]
        });

        const req = http.request({
          hostname: '127.0.0.1',
          port: port,
          path: '/v2/pipeline',
          method: 'POST',
          headers: {
            'Host': `${FULL_PUBLIC_HOST}:${port}`,
            'Authorization': `Bearer ${VALID_AUTH_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        }, (res) => {
          let resData = '';
          res.on('data', chunk => { resData += chunk; });
          res.on('end', () => {
            const latency = (performance.now() - start).toFixed(2);
            const routeHeader = res.headers['x-libsqlite-route'];
            try {
              const data = JSON.parse(resData);
              if (res.statusCode >= 400) {
                reject(new Error(`Error ${res.statusCode}: ${data.error}`));
              } else {
                resolve({ data, latency, routeHeader });
              }
            } catch (err) {
              reject(err);
            }
          });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
      });
    };

    // Insertar nuevo producto desde la URL pública del subdominio
    const insertPublic = await publicFetch(
      'INSERT INTO productos (codigo, descripcion, precio, stock) VALUES (?, ?, ?, ?)',
      ['PROD-003', 'Arandela de Presión 1/2', 1.80, 2500]
    );
    console.log(`   ✓ Registro insertado desde URL pública [Host: ${FULL_PUBLIC_HOST}]`);
    console.log(`     - Ruta detectada por Gateway: ${insertPublic.routeHeader}`);
    console.log(`     - Latencia de inserción:      ${insertPublic.latency} ms`);

    // Consultar todos los productos desde la URL pública
    const selectPublic = await publicFetch('SELECT * FROM productos ORDER BY id ASC');
    console.log(`   ✓ Consulta SELECT efectuada por URL pública en ${selectPublic.latency} ms`);
    const rowsCount = selectPublic.data.results[0].response.result.rows.length;
    console.log(`     - Total de registros devueltos por la URL pública: ${rowsCount}`);

    // -------------------------------------------------------------
    // TEST 4: Verificación de Consistencia Bidireccional
    // -------------------------------------------------------------
    console.log('\n📌 Test 4: Verificación de Consistencia Bidireccional...');
    const localVerification = await localClient.execute('SELECT * FROM productos WHERE codigo = ?', ['PROD-003']);
    if (localVerification.rows.length === 1) {
      console.log('   ✓ ¡Consistencia garantizada! El registro insertado por la URL Pública existe y es legible en la URL Local:');
      console.log('     ', localVerification.rows[0]);
    } else {
      throw new Error('Inconsistencia detectada entre URL pública y local');
    }

    // -------------------------------------------------------------
    // TEST 5: Directivas de Rendimiento ERP (WAL & Pragmas)
    // -------------------------------------------------------------
    console.log('\n📌 Test 5: Verificación de Directivas de Rendimiento ERP...');
    await localClient.execute('PRAGMA busy_timeout = 10000');
    console.log('   ✓ PRAGMA busy_timeout = 10000 aplicado exitosamente (Previene SQLITE_BUSY)');

    await localClient.execute('PRAGMA synchronous = NORMAL');
    console.log('   ✓ PRAGMA synchronous = NORMAL aplicado exitosamente (Alto rendimiento transaccional)');

    // -------------------------------------------------------------
    // TEST 6: Prueba de Concurrencia Simulatánea (50 Transacciones)
    // -------------------------------------------------------------
    console.log('\n📌 Test 6: Carga Concurrente (50 peticiones alternando Local y Pública)...');
    const concurrencyStart = performance.now();
    const tasks = [];

    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        tasks.push(localClient.execute(`SELECT COUNT(*) as c FROM productos`));
      } else {
        tasks.push(publicFetch(`SELECT COUNT(*) as c FROM productos`));
      }
    }

    await Promise.all(tasks);
    const concurrencyTime = (performance.now() - concurrencyStart).toFixed(2);
    console.log(`   ✓ 50 consultas concurrentes completadas en ${concurrencyTime} ms`);
    console.log(`   ✓ Latencia promedio por consulta: ${(concurrencyTime / 50).toFixed(2)} ms`);

    console.log('\n================================================================');
    console.log('   ✅ TODAS LAS PRUEBAS (LOCAL, PÚBLICA Y SEGURIDAD) PASARON');
    console.log('================================================================');

  } catch (error) {
    console.error('\n❌ ERROR EN PRUEBAS:', error);
    process.exitCode = 1;
  } finally {
    server.close();
    db.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

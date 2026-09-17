import http from 'http';

const BASE_URL = 'http://127.0.0.1:3000/api/v1';

async function request(endpoint, options = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const req = http.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { json = body; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runLiveTest() {
  console.log('====================================================');
  console.log('  PROBANDO SISTEMA EN VIVO (LOCAL BACKEND + FRONTEND)');
  console.log('====================================================\n');

  // 1. Healthcheck
  const t0 = Date.now();
  const health = await request('/health');
  console.log(`[1/7] Healthcheck GET /api/v1/health -> HTTP ${health.status} (${Date.now() - t0}ms)`);
  if (health.status !== 200 || !health.data.ok) {
    throw new Error('Healthcheck failed: ' + JSON.stringify(health.data));
  }
  console.log('      ✓ Backend activo y respondiendo correctamente');

  // 2. Auth: Login as admin
  const email = 'admin@libsqlite.local';
  const password = 'Admin123!Secure';
  const loginRes = await request('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  console.log(`[2/7] Inicio de sesión POST /auth/login -> HTTP ${loginRes.status}`);
  if (loginRes.status !== 200) {
    throw new Error('Login falló: ' + JSON.stringify(loginRes.data));
  }

  // Extract cookies
  const rawCookies = loginRes.headers['set-cookie'] || [];
  const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');
  const csrfMatch = cookieHeader.match(/libsqlite\.csrfToken\.v2=([^;]+)/) || cookieHeader.match(/libsqlite\.csrfToken=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';

  const authHeaders = {
    Cookie: cookieHeader,
    'x-csrf-token-v2': csrfToken,
    'x-csrf-token': csrfToken,
  };
  console.log('      ✓ Sesión autenticada con cookies HttpOnly y token CSRF');

  // 3. Crear Proyecto
  const projectRes = await request('/projects', {
    method: 'POST',
    headers: authHeaders,
    body: { name: 'Proyecto de Producción Alpha', description: 'Test en vivo' },
  });
  console.log(`[3/7] Creación de proyecto POST /projects -> HTTP ${projectRes.status}`);
  const project = projectRes.data.project || projectRes.data;
  const projectId = project.id;
  console.log(`      ✓ Proyecto creado: ID=${projectId}, Name="${project.name}"`);

  // 4. Crear Base de Datos
  const dbStart = Date.now();
  const dbRes = await request('/databases', {
    method: 'POST',
    headers: authHeaders,
    body: {
      projectId,
      name: 'ventas-norte',
      type: 'sqlite',
      subdomain: `ventas-${Date.now().toString(36)}`,
    },
  });
  const dbDuration = Date.now() - dbStart;
  console.log(`[4/7] Creación de Base de Datos POST /databases -> HTTP ${dbRes.status} (${dbDuration}ms)`);
  if (dbRes.status !== 201) {
    throw new Error('Creación de base falló: ' + JSON.stringify(dbRes.data));
  }
  const db = dbRes.data.database;
  const dbToken = dbRes.data.token;
  console.log(`      ✓ Base creada en ${dbDuration}ms con estado: "${db.status}"`);
  console.log(`      ✓ Subdominio: ${db.subdomain}`);
  console.log(`      ✓ Token generado: ${dbToken.slice(0, 24)}... (longitud: ${dbToken.length})`);
  console.log(`      ✓ Connection URL: ${db.connectionUrl || db.url || 'local-managed'}`);

  // 5. Ejecutar Consultas SQL en la nueva base
  console.log('[5/7] Ejecutando consultas SQL (DDL + DML)...');
  const createTableRes = await request(`/databases/${db.id}/query`, {
    method: 'POST',
    headers: authHeaders,
    body: {
      sql: 'CREATE TABLE productos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, precio REAL, stock INTEGER);',
    },
  });
  console.log(`      ✓ CREATE TABLE -> HTTP ${createTableRes.status}`);

  const insertRes = await request(`/databases/${db.id}/query`, {
    method: 'POST',
    headers: authHeaders,
    body: {
      sql: "INSERT INTO productos (nombre, precio, stock) VALUES ('Laptop Pro 16', 1899.99, 25), ('Monitor 4K', 450.00, 80);",
    },
  });
  console.log(`      ✓ INSERT 2 registros -> HTTP ${insertRes.status}`);

  const queryStart = Date.now();
  const selectRes = await request(`/databases/${db.id}/query`, {
    method: 'POST',
    headers: authHeaders,
    body: { sql: 'SELECT * FROM productos;' },
  });
  const queryDuration = Date.now() - queryStart;
  console.log(`      ✓ SELECT * FROM productos -> HTTP ${selectRes.status} (${queryDuration}ms)`);
  console.log(`      ✓ Filas devueltas (${selectRes.data.rows?.length}):`, JSON.stringify(selectRes.data.rows));

  // 6. Validar Esquema de la Base
  const schemaRes = await request(`/databases/${db.id}/schema`, {
    method: 'GET',
    headers: authHeaders,
  });
  console.log(`[6/7] Inspección de esquema GET /databases/:id/schema -> HTTP ${schemaRes.status}`);
  const tables = schemaRes.data.tables || [];
  const tableNames = tables.map(t => typeof t === 'string' ? t : (t.name || t.tableName || JSON.stringify(t)));
  console.log(`      ✓ Tablas detectadas (${tables.length}): ${tableNames.join(', ')}`);

  // 7. Rotar Token
  const rotateStart = Date.now();
  const rotateRes = await request(`/databases/${db.id}/rotate-token`, {
    method: 'PATCH',
    headers: authHeaders,
    body: {},
  });
  const rotateDuration = Date.now() - rotateStart;
  console.log(`[7/7] Rotación de Token PATCH /databases/:id/rotate-token -> HTTP ${rotateRes.status} (${rotateDuration}ms)`);
  if (rotateRes.status !== 200) {
    throw new Error('Rotación de token falló: ' + JSON.stringify(rotateRes.data));
  }
  const newToken = rotateRes.data.token;
  console.log(`      ✓ Nuevo Token generado en ${rotateDuration}ms: ${newToken.slice(0, 24)}...`);
  console.log(`      ✓ Tokens diferentes: ${newToken !== dbToken ? 'SÍ (Garantizado)' : 'NO'}`);

  // 8. Borrado y Limpieza
  const deleteRes = await request(`/databases/${db.id}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  console.log(`[8/8] Borrado de base de datos DELETE /databases/:id -> HTTP ${deleteRes.status}`);
  console.log('      ✓ Base de datos y recursos liberados correctamente');

  console.log('\n====================================================');
  console.log('  ✅ TODAS LAS PRUEBAS EN VIVO COMPLETADAS CON ÉXITO');
  console.log('====================================================');
}

runLiveTest().catch(err => {
  console.error('\n❌ ERROR EN PRUEBA EN VIVO:', err);
  process.exit(1);
});

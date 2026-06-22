const { createClient } = require('@libsql/client');

async function testLibsqlProxy() {
  console.log('🧪 Iniciando test de integración de LibSQL Proxy Native...');

  // Asumiremos que el servidor ya está corriendo localmente en el puerto 3000
  // y que tenemos una base de datos de prueba creada por el backend.
  // Pero como no sabemos el ID, podemos simplemente hacer una petición REST 
  // para crear una base de datos efímera, obtener su token, probar el proxy
  // y luego eliminarla.
  
  const baseUrl = 'http://localhost:3000';
  
  try {
    console.log('1️⃣ Creando base de datos de prueba vía API REST...');
    const createRes = await fetch(`${baseUrl}/api/v1/databases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test_proxy_db' })
    });
    
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Fallo al crear DB: ${createRes.status} ${text}`);
    }
    
    const { database, token } = await createRes.json();
    console.log(`✅ Base de datos creada: ${database.id}`);
    
    // 2. Conectar vía @libsql/client usando nuestro proxy HTTP nativo
    console.log('\n2️⃣ Conectando el cliente @libsql/client a nuestro proxy Node.js...');
    const client = createClient({
      url: `${baseUrl}/api/v1/libsql/${database.id}`,
      authToken: token,
    });
    
    console.log('\n3️⃣ Ejecutando consultas SQL a través del pipeline proxy...');
    await client.execute(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY, nombre TEXT)`);
    console.log('✅ Tabla creada');
    
    await client.execute({
      sql: `INSERT INTO usuarios (nombre) VALUES (?)`,
      args: ['Joshua']
    });
    console.log('✅ Registro insertado exitosamente usando positional args');
    
    const rs = await client.execute(`SELECT * FROM usuarios`);
    console.log('✅ Select exitoso. Datos devueltos:');
    console.table(rs.rows);
    
    if (rs.rows[0].nombre === 'Joshua') {
      console.log('🎉 EL PROXY HTTP DE LIBSQL FUNCIONA A LA PERFECCIÓN!');
    } else {
      console.error('❌ Los datos devueltos no coinciden.');
    }
    
    // Cleanup
    console.log('\n4️⃣ Limpiando la base de datos de prueba...');
    await fetch(`${baseUrl}/api/v1/databases/${database.id}`, { method: 'DELETE' });
    console.log('✅ Base de datos de prueba eliminada');
    
  } catch(e) {
    console.error('❌ Fallo el test de integración:', e.message);
  }
}

testLibsqlProxy();

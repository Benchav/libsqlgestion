# Plan de Optimización de Rendimiento y Reducción de Latencia

Se ha detectado una alta latencia (8-10 segundos) al realizar operaciones de escritura o edición (ej. "facturas a créditos") utilizando LibSQLite de forma local en un servidor privado. 

Tras analizar la arquitectura, el código del backend y la configuración del motor de datos, se han identificado cuellos de botella críticos, principalmente relacionados con la **ausencia de un pool de conexiones**, **lecturas de disco síncronas bloqueantes por consulta** y **falta de configuración de alto rendimiento en SQLite**.

## User Review Required

> [!WARNING]
> **Cambio Arquitectónico en la Gestión de Conexiones**
> Actualmente, las conexiones a las bases de datos son "stateless" (se abren y cierran en cada consulta). El plan propone mantener las conexiones abiertas y cacheadas en memoria en el backend para reutilizarlas. Esto requerirá memoria adicional en el servidor Node.js proporcional al número de bases de datos activas simultáneamente, pero reducirá el tiempo de respuesta de segundos a milisegundos.

## Open Questions

> [!IMPORTANT]
> 1. **Uso de Facturación desde Frontend**: Cuando mencionas que "tarda entre 8 a 10 segundos algunas consultas para edición de facturas", ¿el sistema externo que usas hace múltiples consultas SQL (una por línea de factura, por ejemplo) en un bucle hacia la API de LibSQLite? Si es así, la reutilización de conexiones bajará drásticamente el tiempo, pero también podríamos necesitar asegurarnos de que uses `batch` o un `script` SQL en un solo request para optimizarlo al máximo.
> 2. **Tipos de Bases de Datos Afectadas**: ¿Esta latencia ocurre en bases administradas por los contenedores (`libsql`) o en archivos locales directos (`sqlite`) adjuntos al backend? (El plan cubre ambas optimizaciones).

## Proposed Changes

### 1. Sistema de Caché/Pool de Conexiones

Se implementará un `ConnectionManager` o `ClientPool` de tipo Singleton para mantener en memoria las instancias activas y reutilizarlas.

#### [NEW] `backend/src/infrastructure/db/ConnectionPool.ts`
- Se creará una clase `ConnectionPool` que mantendrá un `Map<string, SqliteClient | Client>`.
- Devolverá el cliente si ya existe; de lo contrario, lo creará.
- Para simplificar e iterar rápido, de entrada las conexiones se mantendrán vivas de forma permanente o hasta que el servidor se reinicie.

### 2. Refactorización de Servicios para usar el Pool

Los servicios no deben crear y cerrar el cliente, sino pedirlo al Pool.

#### [MODIFY] `backend/src/application/databases/QueryService.ts`
- Eliminar los bloques `finally { client.close(); }`.
- Reemplazar las creaciones de clientes por una llamada estática `ConnectionPool.getClient(database)`.

#### [MODIFY] `backend/src/application/databases/SchemaService.ts`, `MigrationService.ts`, `DatabaseService.ts` y `SchemaManagementService.ts`
- Actualizar el acceso al cliente para que use el Pool en todos los servicios, evitando instanciación duplicada.
- Eliminar `.close()`.

### 3. Optimización del Motor SQLite Local

Mejorar drásticamente el rendimiento de lectura/escritura en los archivos locales `.sqlite`.

#### [MODIFY] `backend/src/infrastructure/sqlite/SqliteClient.ts`
- **Eliminar I/O síncrono:** Quitar la validación `fs.readSync` (los 16 bytes "SQLite format 3") del constructor. Al estar dentro del Pool de conexiones, este I/O se haría una sola vez en lugar de por query, pero de todos modos es mejor evitar bloquear el event loop principal. Se pasará esa comprobación al método `checkIntegrity()` explícito.
- **Activar WAL:** Añadir `this.db.run('PRAGMA journal_mode = WAL;');` dentro del bloque de `serialize`. El modo WAL permite lecturas y escrituras concurrentes sin bloquear la base de datos entera, usando un archivo Write-Ahead Log. Esto soluciona los problemas de latencia al escribir facturas.

## Verification Plan

### Automated Tests
- Al no tener suites de test configurados por defecto detallados, nos basaremos en validaciones unitarias en modo desarrollo si aplican.

### Manual Verification
- Levantar el proyecto usando `npm run dev` en el backend y probar desde el panel de control.
- Ejecutar múltiples *queries* secuenciales (esquema, consultas crudas) usando el Studio. La latencia debería caer de >1000ms a <20ms de forma consistente.
- Comprobar logs del backend para asegurar que no haya warnings por demasiados descriptores de archivo o memoria, verificando que la conexión se recicle exitosamente.
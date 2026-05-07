# faltantes

## Estado actual

- Backend y frontend compilan correctamente.
- El flujo de creación/importación de bases ya levanta runtime libSQL por base.
- El rotate de token fue ajustado para recrear el contenedor con la nueva llave.
- Se agregó `backendConnectionUrl` para distinguir uso interno y uso para backend/producción.

## Pendientes críticos

1. Validar en el despliegue real que el backend nuevo esté corriendo y no quede una imagen vieja cacheada.
2. Confirmar que los contenedores libSQL nuevos ya no lean `SQLD_AUTH_JWT_KEY_FILE` en logs.
3. Probar importación de SQLite en el entorno final con una base real.
4. Probar rotate token en el entorno final y verificar que:
   - el token nuevo se muestra,
   - el runtime queda activo,
   - la conexión sigue funcionando.
5. Definir una URL pública estable para producción:
   - `DATABASE_PUBLIC_URL_TEMPLATE`, o
   - `DATABASE_PUBLIC_BASE_URL`, o
   - `DATABASE_PUBLIC_HOST` real.

## Pendientes de validación funcional

- Verificar que `Public URL` no se confunda con `Backend URL`.
- Verificar que `Internal URL` sea resoluble solo dentro de la red Docker.
- Verificar que `Backend URL` sea el valor recomendado para el backend del usuario.
- Verificar `POST /api/v1/databases/import-upload` con archivo real.
- Verificar `POST /api/v1/databases/import-sqlite` con ruta real del servidor.
- Verificar `POST /api/v1/databases/:id/test-connection` después de create/import/rotate.
- Verificar `DELETE /api/v1/databases/:id` limpia contenedor y archivos asociados.

## Pendientes de despliegue

- Redeploy limpio del backend.
- Redeploy limpio del frontend.
- Si aplica, borrar contenedores fallidos de libSQL.
- Confirmar variables de entorno en el entorno final:
  - `MASTER_KEY`
  - `DATABASE_FILE`
  - `SQLITE_STORAGE_ROOT`
  - `DATABASE_PUBLIC_HOST`
  - `DATABASE_PUBLIC_PROTOCOL`
  - `DOCKER_SOCKET_PATH`
  - `LIBSQL_SERVER_IMAGE`

## Riesgos conocidos

- Si el backend sigue mostrando logs antiguos, el problema es un artefacto desplegado viejo.
- Si `DATABASE_PUBLIC_HOST` apunta a localhost/127.0.0.1 en producción, las URLs no serán útiles fuera del contenedor.
- Si Coolify o Docker no comparten red correctamente, `internalUrl` puede no servir para backend remoto.
- Si el runtime libSQL falla por auth, el log deberá revisarse en el contenedor recién creado.

## Próximos pasos sugeridos para mañana

1. Hacer redeploy limpio.
2. Crear una base nueva de prueba.
3. Importar una SQLite real.
4. Rotar el token.
5. Confirmar qué URL usarás desde tu backend real.
6. Si algo falla, guardar el log exacto del contenedor y corregir solo ese punto.

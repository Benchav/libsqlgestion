# cambiosservelibsql

## Resumen

Este documento resume todo lo que se cambió para intentar convertir la plataforma en un sistema que levanta un servidor libSQL real por cada base de datos administrada, además de explicar el error que sigue persistiendo al importar o crear una base.

La intención fue pasar de un panel que solo guardaba metadata y archivos SQLite a un flujo donde cada base administrada tenga su propio runtime libSQL, con URL y token copiables desde el panel.

## Lo que se implementó

### 1. Provisionamiento real de libSQL por base

Se agregó un servicio de runtime en Docker para crear un contenedor libSQL por base administrada:

- Archivo: [backend/src/infrastructure/docker/LibsqlRuntimeService.ts](backend/src/infrastructure/docker/LibsqlRuntimeService.ts)
- Este servicio:
  - genera un JWT Ed25519 para autenticación,
  - crea el contenedor `ghcr.io/tursodatabase/libsql-server:latest`,
  - monta el archivo SQLite administrado,
  - monta la llave pública JWT,
  - espera a que el contenedor exponga el puerto,
  - intenta validar la conexión con `SELECT 1`,
  - elimina el contenedor cuando la base se borra.

### 2. Integración con alta, importación, rotación y borrado

Se conectó ese runtime al flujo principal de bases:

- Archivo: [backend/src/application/databases/DatabaseService.ts](backend/src/application/databases/DatabaseService.ts)
- Cambios relevantes:
  - al crear una base SQLite administrada se intenta levantar un servidor libSQL real,
  - al importar una base SQLite se repite el mismo proceso,
  - al rotar token se vuelve a generar el JWT,
  - al borrar la base se intenta borrar el contenedor asociado.

### 3. URLs de conexión y detectabilidad automática

Se ajustó la lógica para que el panel muestre URLs copiables y trate de resolver la URL que realmente respondió:

- Archivo: [backend/src/application/databases/connection-url.ts](backend/src/application/databases/connection-url.ts)
- Archivo: [backend/src/presentation/http/controllers/DatabaseController.ts](backend/src/presentation/http/controllers/DatabaseController.ts)
- Archivo: [backend/src/presentation/http/controllers/ProvisioningController.ts](backend/src/presentation/http/controllers/ProvisioningController.ts)

Ahora el panel expone:

- `connectionUrl`
- `publicConnectionUrl`
- `internalConnectionUrl`
- token JWT copiable

### 4. Mejoras de error

Se dejaron de ocultar errores de provisión detrás de un mensaje genérico y se intentó devolver el motivo real desde el backend:

- errores de creación,
- errores de importación,
- errores del runtime libSQL,
- timeouts de conexión,
- logs del contenedor cuando el proceso se cae.

### 5. Documentación y despliegue

Se documentó el uso de Docker socket, la imagen libSQL y los valores de entorno necesarios:

- Archivo: [backend/.env.example](backend/.env.example)
- Archivo: [backend/README.md](backend/README.md)
- Archivo: [docker-compose.yml](docker-compose.yml)

## Estado actual del comportamiento

La plataforma ya no solo crea registros: intenta levantar un runtime libSQL real por base administrada.

Pero el error sigue ocurriendo al importar o crear una base, y la consola muestra:

```text
POST /api/v1/databases/import-upload 500 (Internal Server Error)
Timed out waiting for libSQL to accept connections
```

## Qué significa ese error

El contenedor probablemente sí se está intentando crear, pero el backend no logra confirmar que el servidor libSQL esté aceptando conexiones dentro del tiempo de espera.

Eso puede pasar por varias razones:

1. El contenedor arranca y se cae de inmediato.
2. El servidor libSQL no logra abrir el archivo SQLite montado.
3. La llave JWT o su formato no son aceptados al iniciar.
4. El contenedor está en una red distinta a la del backend y no se puede resolver el host.
5. La URL pública usada por el backend no es accesible desde el propio backend.
6. La imagen `ghcr.io/tursodatabase/libsql-server:latest` no está arrancando bien en el entorno real de Coolify.
7. El backend sí levanta el contenedor, pero `SELECT 1` no completa porque el servicio aún no está listo o porque la auth falla.

## Causas que considero más probables

### A. Problema de red entre contenedores

Esta es la hipótesis más fuerte.

El backend corre en su propio contenedor y el runtime libSQL en otro. Si Coolify no les deja compartir red de forma esperada, o si la URL elegida no es resoluble desde el backend, la validación siempre acabará en timeout.

### B. El contenedor libSQL sí arranca, pero no queda listo a tiempo

Si el contenedor tarda más de lo esperado en inicializar el archivo, cargar auth o abrir el puerto, el backend terminará registrando timeout aunque el servidor finalmente llegue a estar listo.

### C. Auth JWT incompatible con el servidor libSQL

Se generó un JWT Ed25519 sin claims para acceso completo, pero si el runtime espera otro formato o la imagen usa una política distinta, el `SELECT 1` no pasará validación.

### D. Volumen o archivo SQLite problemático

Si el archivo montado está corrupto, vacío en un momento incorrecto, o el contenedor no puede abrirlo por permisos, el runtime puede arrancar y luego cerrarse.

### E. El host público configurado en Coolify no es el correcto

Si `DATABASE_PUBLIC_HOST` no apunta a una dirección alcanzable desde el backend y desde el otro proyecto, la URL generada no servirá para confirmar conexión.

### F. El log real del contenedor todavía no se está viendo en la UI

Aunque el backend ya intenta capturar logs del contenedor, si el fallo ocurre muy pronto o si Docker no expone el error esperado, el mensaje puede seguir siendo poco informativo.

## Qué ya se validó

- El backend compila correctamente.
- La lógica de provisión y rotación quedó integrada al flujo de bases.
- Se mejoró la devolución de errores en los endpoints de creación/importación.
- Se intentó distinguir entre URL pública e interna, y luego priorizar la URL que realmente responde.

## Conclusión

La plataforma ya está preparada para intentar levantar un servidor libSQL real por base, pero en el entorno actual el runtime no termina de quedar accesible y por eso la importación/creación sigue fallando con timeout.

El problema ya no parece ser del frontend. El foco ahora está en el despliegue real del contenedor libSQL, la red Docker/Coolify y la forma en que se valida la conexión al arrancar.

## Siguiente paso recomendado

Revisar el log real del contenedor libSQL que se crea al importar o crear una base, porque ahí debería aparecer la causa exacta: red, permisos, auth o apertura del archivo SQLite.


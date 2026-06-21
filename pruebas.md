# Pruebas Pendientes y Plan de Verificacion

## Objetivo general

Dejar validado de forma real en produccion que `libsqlite` funciona correctamente en los dos escenarios principales:

1. Consumo local entre proyectos desplegados en el mismo servidor con Coolify.
2. Consumo remoto/publico mediante URL `libsql://` o `https://`.

Tambien dejar confirmada la visualizacion correcta de:

1. Tablas.
2. Registros.
3. Conteos.
4. Consultas.
5. Salud del runtime.

---

## Estado actual resumido

### Ya corregido en codigo

1. Importacion de SQLite con snapshot consistente usando `VACUUM INTO`.
2. Correccion del bug `URL_INVALID` por uso de path local como URL remota.
3. Reconciliacion de registros legacy al arranque.
4. Resolucion de `effectiveType` (`sqlite`, `libsql`, `remote`).
5. Serializer con:
   - `preferredLocalConnectionUrl`
   - `preferredRemoteConnectionUrl`
   - `publicLibsqlUrl`
   - `backendConnectionUrl`
   - `internalConnectionUrl`
6. `Test Connection` con verificacion por ruta:
   - Internal
   - Backend
   - Public
7. Suite automatizada backend pasando.

### Aun pendiente de validar en produccion

1. Que el backend ERP real puede resolver el runtime local por DNS interno.
2. Que la URL local recomendada sea estable y correcta para la base real importada.
3. Que el Studio ya muestre tablas y datos reales de la base actual importada en el entorno real.
4. Que el runtime nuevo este usando el alias interno esperado y no uno viejo/heredado.
5. Que la URL publica tambien responda correctamente desde un cliente externo.

---

## Hallazgo importante actual

En Docker se confirmo que el runtime actual de la base inspeccionada existe y esta dentro de la red `coolify`.

Ejemplo observado:

```text
Contenedor runtime:
libsqlite-341c15d7-8a5c-4442-9bae-808a9e214d85

Red:
coolify

Aliases reales:
- libsqlite-341c15d7-8a5c-4442-9bae-808a9e214d85
- libsqlite-insumosv1-ddba0a09
```

Esto implica que:

1. La red `coolify` ya esta bien compartida.
2. El runtime existe.
3. El alias real que hoy resuelve el runtime puede ser diferente del nombre esperado visualmente.

Riesgo actual:

1. El sistema o el ERP pueden estar intentando usar `libsqlite-insumosv1`.
2. Pero Docker hoy esta exponiendo realmente `libsqlite-insumosv1-ddba0a09`.

---

## Bloque 1 - Identificar correctamente el contenedor del ERP backend

### Objetivo

Confirmar cual contenedor Docker corresponde realmente a `insbr-api`.

### Comandos

Ejecutar en el host:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

Luego filtrar candidatos:

```bash
docker ps --format '{{.Names}} {{.Image}}' | grep -i insbr
docker ps --format '{{.Names}} {{.Image}}' | grep -i ibarrera
```

### Resultado esperado

1. Encontrar el nombre real del contenedor del backend ERP.
2. Guardar ese nombre para entrar luego con `docker exec`.

### Si falla

1. Revisar en Coolify el tab `Terminal` de `insbr-api`.
2. Confirmar el nombre fisico del contenedor via logs o via `docker inspect`.

---

## Bloque 2 - Validar DNS interno local desde el ERP backend

### Objetivo

Comprobar si el backend ERP puede resolver por red Docker el runtime de la base.

### Paso 1

Entrar al contenedor real del ERP backend:

```bash
docker exec -it <contenedor_erp_backend> sh
```

### Paso 2

Probar resolucion DNS del alias real detectado:

```sh
getent hosts libsqlite-insumosv1-ddba0a09 || ping -c 1 libsqlite-insumosv1-ddba0a09
```

### Resultado esperado

1. Debe devolver una IP de la red `coolify`.
2. Si responde, el problema no es DNS interno.

### Si falla

1. El contenedor ERP no esta resolviendo aliases de esa red.
2. Hay que revisar red Docker o alias del runtime.
3. Posible necesidad de recrear el runtime o ajustar aliases estables.

---

## Bloque 3 - Validar acceso HTTP local al runtime desde el ERP backend

### Objetivo

Comprobar si el ERP puede consumir realmente el runtime por la URL local.

### Comando

Dentro del contenedor del ERP backend:

```sh
wget -qO- http://libsqlite-insumosv1-ddba0a09:8080 || curl -i http://libsqlite-insumosv1-ddba0a09:8080
```

### Resultado esperado

1. Debe responder el runtime libSQL.
2. Si responde, la ruta local interna esta funcionando.

### Si falla

1. El alias DNS existe pero el runtime no responde.
2. Puede ser un problema del runtime, del contenedor o del listener.

### Accion siguiente si falla

1. Revisar logs del runtime.
2. Ejecutar `Test Connection` desde el panel.
3. Verificar `runtimeHealth`.

---

## Bloque 4 - Validar el consumo real desde el ERP backend usando `@libsql/client`

### Objetivo

Asegurar que el backend ERP puede hacer consultas reales a la base.

### Variables a probar

#### Opcion local

```env
TURSO_DATABASE_URL=http://libsqlite-insumosv1-ddba0a09:8080
TURSO_AUTH_TOKEN=<token_actual>
```

#### Opcion publica

```env
TURSO_DATABASE_URL=libsql://insumosv1-ddba0a09.ibarerra.site
TURSO_AUTH_TOKEN=<token_actual>
```

### Script minimo sugerido

```ts
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const rs = await client.execute('SELECT 1 as ok');
console.log(rs.rows);
```

### Resultado esperado

1. El modo local debe devolver resultado.
2. El modo remoto debe devolver resultado.

### Si uno falla y el otro no

Interpretacion:

1. Local falla y remoto funciona:
   - problema de red interna/DNS/alias.
2. Remoto falla y local funciona:
   - problema de dominio publico, proxy, TLS o exposure.
3. Ambos fallan:
   - problema de token, runtime roto o configuracion de la base.

---

## Bloque 5 - Validar visualizacion de tablas y datos en Studio

### Objetivo

Confirmar que la base importada real muestra:

1. tablas
2. vistas
3. columnas
4. registros
5. row counts

### Pasos

1. Entrar a la base en el panel.
2. Abrir `Open Studio`.
3. Pulsar `Test Connection`.
4. Observar `Runtime Health`.
5. Verificar si aparecen tablas en sidebar.
6. Seleccionar una tabla.
7. Confirmar que aparecen registros.

### Requests a inspeccionar en navegador

En DevTools > Network:

1. `GET /api/v1/databases/:id/schema`
2. `POST /api/v1/databases/:id/query` con:
   - `SELECT COUNT(*) as cnt FROM ...`
   - `SELECT * FROM ... LIMIT 50 OFFSET 0`

### Resultado esperado

1. `/schema` devuelve 200 con `tables` y `views`.
2. `/query` devuelve 200 con `rows`.
3. `rowCount` coincide con datos visibles.

### Si falla con `fetch failed`

1. revisar respuesta exacta del endpoint backend
2. revisar banner de error completo
3. revisar logs del backend principal `libsqlgestion`

---

## Bloque 6 - Validar `Runtime Health` del panel

### Objetivo

Usar el propio panel para saber cual ruta funciona.

### Pasos

1. Abrir la base en detalle.
2. Pulsar `Test Connection`.
3. Leer:
   - Internal
   - Backend
   - Public

### Interpretacion

#### Caso A

```text
Internal OK
Backend OK
Public OK
```

Todo bien.

#### Caso B

```text
Internal OK
Backend OK
Public Fail
```

La red local funciona; el problema es exposure publico.

#### Caso C

```text
Internal Fail
Backend Fail
Public OK
```

La publica sirve, pero la local entre proyectos no.

#### Caso D

```text
Internal Fail
Backend Fail
Public Fail
```

El runtime o token no estan funcionando.

---

## Bloque 7 - Validar que el runtime actual use el alias correcto

### Objetivo

Comprobar si el runtime de la base actual tiene el alias interno que esperamos.

### Comando

En el host:

```bash
docker inspect <runtime_container_name> --format '{{json .NetworkSettings.Networks}}'
```

### Revisar especialmente

1. `Aliases`
2. `DNSNames`

### Resultado esperado

Algo como:

```text
Aliases:
- libsqlite-<uuid>
- libsqlite-insumosv1-ddba0a09
```

### Pendiente de mejora futura

Idealmente deberiamos estabilizar aun mas el alias para que no dependa del sufijo del subdomain si se desea DX mas limpio.

---

## Bloque 8 - Validar si hay runtimes viejos o basura operativa

### Objetivo

Ver si contenedores viejos estan confundiendo la operacion.

### Comandos

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep libsqlite
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep libsqlite
```

### Revisar

1. cuantos runtimes existen
2. si hay runtimes viejos de bases borradas
3. si hay contenedores que reinician o quedan a medias

---

## Bloque 9 - Validar URL publica remota

### Objetivo

Confirmar si la URL publica remota sirve desde fuera.

### Comando sugerido desde el host o cliente externo

```bash
curl -I https://insumosv1-ddba0a09.ibarerra.site
```

O con cliente real `@libsql/client`.

### Resultado esperado

1. resolucion DNS publica correcta
2. proxy/traefik correcto
3. runtime responde

---

## Bloque 10 - Si el backend ERP sigue sin aparecer en `docker ps | grep insbr-api`

### Objetivo

Identificar el nombre fisico real del contenedor.

### Comandos

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker ps --format '{{.Names}} {{.Image}}' | grep -i insbr
docker ps --format '{{.Names}} {{.Image}}' | grep -i ibarrera
```

### Alternativa

Entrar desde la UI de Coolify > `Terminal` de `insbr-api`.

---

## Bloque 11 - Mejoras futuras recomendadas

### 1. Alias local mas limpio

Hoy el alias real observado fue:

```text
libsqlite-insumosv1-ddba0a09
```

Evaluar si en una fase posterior conviene llevarlo a:

```text
libsqlite-insumosv1
```

siempre que no rompa unicidad.

### 2. UI de diagnostico mas fuerte

Mostrar en el panel:

1. alias real Docker
2. host interno estable
3. si el ERP backend esta en la misma red

### 3. Test de runtime real con alias local

Agregar una prueba automatizada de mayor nivel que simule reachability local interna cuando el runtime esta marcado como `docker-libsql`.

---

## Checklist rapido para reanudar luego

### Produccion

- [ ] identificar contenedor real del ERP backend
- [ ] entrar al contenedor del ERP backend
- [ ] probar DNS `libsqlite-insumosv1-ddba0a09`
- [ ] probar `wget/curl` a `http://libsqlite-insumosv1-ddba0a09:8080`
- [ ] probar `@libsql/client` local con token real
- [ ] probar `@libsql/client` remoto con URL publica
- [ ] pulsar `Test Connection` en el panel
- [ ] anotar estado de Internal / Backend / Public
- [ ] abrir Studio y verificar tablas/rows

### Si falla local pero no publico

- [ ] revisar alias DNS del runtime
- [ ] revisar si el ERP backend esta realmente en la red `coolify`
- [ ] revisar si el runtime fue recreado con la version nueva

### Si falla todo

- [ ] revisar token
- [ ] revisar logs del runtime
- [ ] revisar logs del backend `libsqlgestion`
- [ ] revisar si la base importada corresponde a la esperada

---

## Nota importante final

No asumir que una prueba hecha desde el host (`root@ibarrera`) valida la red Docker interna.

La validacion correcta del uso local entre proyectos debe hacerse **desde dentro del contenedor del ERP backend** o desde el `Terminal` del proyecto en Coolify.

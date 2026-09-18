# Documentacion Tecnica: Arquitectura, Implementacion y Validacion de Bases de Datos Dinamicas

## 1. Resumen General del Proyecto

LibSQLGestion es una plataforma de base de datos como servicio (DaaS) auto-hospedada (self-hosted), inspirada en la arquitectura de Turso, disenada para aprovisionar, administrar y consumir bases de datos SQLite y libSQL de forma remota y aislada.

El sistema proporciona:
- Aprovisionamiento instantaneo de bases de datos dinamicas.
- Multitenancy nativo de alto rendimiento basado en namespaces de sqld.
- Soporte hibrido retrocompatible con bases de datos SQLite en archivos locales.
- Conectividad remota mediante protocolo Hrana v2 sobre HTTP compatible con el driver oficial @libsql/client.
- Autenticacion robusta basada en tokens de autorizacion (Bearer tokens).
- Panel de administracion web en Next.js con explorador de esquemas, visor de métricas y consola SQL Studio interactiva.
- Pruebas automatizadas continuas con cobertura unitaria, de integracion y de extremo a extremo (E2E).

---

## 2. Arquitectura de Software y Multitenancy

### 2.1 Reestructuracion a Monorepo
El proyecto fue organizado bajo una estructura de monorepo gestionada por NPM Workspaces:
- Directorio raiz: orquestacion de dependencias compartidas, scripts globales de compilacion y ejecucion de pruebas.
- Directorio backend: servicio API basado en Fastify, TypeORM, cliente SQLite nativo y cliente administrativo de sqld.
- Directorio frontend: interfaz de usuario desarrollada en Next.js 14 (App Router) con React, React Query y TailwindCSS.

### 2.2 Transicion de Contenedor Unico a Namespaces Nativos de sqld
En versiones iniciales, cada base de datos requeria levantar un contenedor Docker individual, lo que generaba un limite estricto de escalabilidad y alto consumo de memoria RAM por instancia.

Se implemento el servicio LibsqlNamespaceService:
- Utiliza la Admin API de sqld sobre el puerto 9090 (/v1/namespaces/{name}).
- Permite crear, listar y eliminar bases de datos como namespaces aislados dentro de un unico proceso central de sqld.
- El tiempo de provisionamiento se redujo de mas de 10 segundos a menos de 10 milisegundos por base de datos.
- El consumo de memoria de la plataforma se optimizo en mas del 90 por ciento.

### 2.3 Modo Hibrido: Soporte Local-File y sqld
Para garantizar total retrocompatibilidad:
- Bases de datos de tipo local-file: operan sobre archivos SQLite individuales ubicados en el sistema de almacenamiento persistente.
- Bases de datos de tipo sqld: operan sobre los directorios internos de sqld utilizando namespaces dedicados.
- Ambas modalidades exponen endpoints compatibles para consumo directo o mediante la pasarela de conexion remota.

---

## 3. Seguridad y Criptografia

### 3.1 Aislamiento Criptografico por Namespace (Ed25519)
- Se implemento un sistema de firma asimetrica de tokens JWT basado en el algoritmo Ed25519 (EdDSA).
- Cada token generado incluye el claim de autorizacion especifico del namespace asignado: {"a": "rw", "ns": "<subdominio>"}.
- La clave privada nunca se expone y permanece en el directorio seguro de autenticacion de sqld.
- La clave publica se distribuye a sqld en formato SPKI PEM.
- Los intentos de usar un token de una base de datos contra el namespace de otra base de datos son rechazados a nivel de motor.

### 3.2 Cifrado en Reposo de Tokens
- La base de datos de control (control.db) almacena los tokens de acceso cifrados con el algoritmo simetrico AES-256-GCM.
- Se utiliza un vector de inicializacion (IV) aleatorio de 12 bytes y un tag de autenticacion de 16 bytes por cada registro cifrado.
- La clave maestra (MASTER_KEY) de 32 bytes (64 caracteres hexadecimales) puede configurarse mediante variables de entorno o persistirse en un archivo seguro.

### 3.3 Autenticacion del Panel Administrativo
- Sesion mediante cookies seguras HttpOnly con banderas SameSite y Secure (en entornos de produccion).
- Proteccion contra ataques de falsificacion de peticion en sitios cruzados (CSRF) mediante tokens aleatorios de 64 caracteres transmitidos en la cabecera x-csrf-token.
- Politica de cabeceras CORS configurada para permitir el intercambio seguro de recursos entre el frontend y el backend, incluyendo soporte explicito para X-CSRF-Token-V2 y X-Database-ID.

---

## 4. Almacenamiento, Concurrencia y Streaming

### 4.1 Optimizacion de Rendimiento en SQLite
Se configuraron directivas transaccionales avanzadas (PRAGMA) por defecto:
- journal_mode = WAL (Write-Ahead Logging): permite lecturas concurrentes sin bloquear escrituras.
- busy_timeout = 10000: espera activa de hasta 10 segundos ante contencion, eliminando los fallos por error SQLITE_BUSY.
- synchronous = NORMAL: optimiza la persistencia en disco manteniendo consistencia ante fallos del sistema operativo.
- cache_size = -64000: asigna hasta 64 MB de memoria de cache por conexion para operaciones intensivas de lectura.

### 4.2 Pool de Conexiones
- Implementacion de ConnectionPool con algoritmo LRU (Least Recently Used) y tiempo de expiracion por inactividad (TTL).
- Evita el agotamiento de descriptores de archivo del sistema operativo y gestiona de forma transparente el reciclaje de conexiones inactivas.

### 4.3 Streaming de Subidas sin Fuga de Memoria
- El proxy de Next.js en app/api/v1/[...path]/route.ts fue redisenado para utilizar transferencia por flujo continuo (streaming con duplex: 'half').
- Se elimino el uso de request.arrayBuffer(), evitando cargar archivos SQLite de gran tamano en la memoria del servidor Next.js y previniendo caidas por exceso de memoria (OOM).

### 4.4 Importacion Consistente con VACUUM INTO
- El servicio SqliteStorageService incorpora el metodo importToNamespace, el cual ejecuta VACUUM INTO sobre bases de datos de origen en modo WAL abierto.
- Garantiza una instantanea consistente y libre de bloqueos para la migracion de bases de datos existentes hacia el almacenamiento de sqld.

---

## 5. Resolucion y Formato de URLs de Conexion

### 5.1 Enrutamiento Dinamico
Se actualizo la logica de resolucion de URLs de conexion en el archivo connection-url.ts para que toda base de datos (tanto local-file como sqld) proporcione sus rutas de acceso de forma transparente:
- URL Publica: ruta HTTPS/WSS orientada al cliente externo cuando se configura un dominio publico o subdominio wildcard.
- URL Backend / Interna: ruta HTTP directa para aplicaciones dentro de la misma red o contenedor (ejemplo: http://127.0.0.1:3000/api/v1/databases/:id/).

### 5.2 Integracion con Reverse Proxy y Traefik
- El archivo docker-compose.yml integra reglas de enrutamiento wildcard para Traefik: HostRegexp('{subdomain:[a-z0-9-]+}.${DATABASE_PUBLIC_DOMAIN}').
- Permite que cada base de datos cuente con un subdominio propio sin necesidad de reiniciar contenedores ni modificar reglas de proxy en caliente.

---

## 6. Pruebas y Verificacion E2E

### 6.1 Suite Integral Automatizada (npm test)
El comando principal ejecuta cuatro etapas consecutivas de validacion:

1. Backend:
   - Compilacion estricta de TypeScript (tsc -p .).
   - 25 pruebas unitarias e integrales en 9 suites (criptografia, llaves Ed25519, hashing, generacion de subdominios, aislamiento de tokens y ejecucion atomica de scripts SQL).
   - Tasa de aprobacion: 100 por ciento.

2. Frontend:
   - Verificacion de tipos estaticos con TypeScript (tsc --noEmit).
   - Compilacion optimizada de produccion con Next.js 14.
   - Generacion de 10 rutas estaticas y dinamicas del panel administrativo.

3. Almacenamiento y Motor (Smoke Tests):
   - Validacion de rutas de almacenamiento en dbs/default/data.
   - Confirmacion de modo WAL, integridad fisica y transacciones atomicas.
   - Prueba del pool de conexiones y desalojo LRU.
   - Verificacion de importacion de snapshots vivos mediante VACUUM INTO.

4. Red y Pasarela (Networking):
   - Validacion comparativa entre URL local y subdominio publico con token.
   - Prueba de rechazo de token invalido (401 Unauthorized).
   - Prueba de carga concurrente con 50 peticiones alternadas (latencia media inferior a 3 milisegundos).

### 6.2 Demostracion de Consumo Remoto de Base de Datos (demo-external-backend.mjs)
Se desarrollo y probo exitosamente un script independiente que simula una aplicacion externa consumiendo la base de datos backend-externo-demo utilizando el cliente oficial @libsql/client:
- Parametros utilizados:
  - Base de Datos ID: 3140d679-18a4-493d-9f43-fb29f766e24b
  - URL de Conexion: http://127.0.0.1:3000/api/v1/databases/3140d679-18a4-493d-9f43-fb29f766e24b/
  - Token Real: ce3249f93097bacb0fd9092c314679ffc3bffdc6eda920460a38339b4d6330f5

- Flujo verificado en la ejecucion:
  - Paso 1: Conexion exitosa con token y URL real en menos de 70 milisegundos.
  - Paso 2: Verificacion de seguridad donde un token falso es rechazado con error 401 Unauthorized.
  - Paso 3: Creacion remota de la tabla productos_demo e insercion de catalogo persistente.
  - Paso 4: Puesta en marcha de una API REST externa simulando servicios de comercio electronico.
  - Paso 5: Ejecucion del ciclo CRUD completo mediante llamadas HTTP:
    - POST: creacion de producto con ID dinamico.
    - GET: listado total de productos.
    - GET por ID: consulta de registro individual.
    - PUT: actualizacion de precios y existencias.
    - DELETE: eliminacion permanente del registro de prueba.
    - Verificacion 404: comprobacion de que el registro eliminado ya no existe.
  - Paso 6: Ejecucion de lote de sentencias atomicas (Batch transaccional en modo write) con multiples inserciones y lecturas en una sola peticion.

---

## 7. Instrucciones para Despliegue en Produccion

### 7.1 Requisitos Previos
- Docker y Docker Compose instalados en el servidor.
- Red externa configurada en Docker si se utiliza un orquestador como Coolify:
  docker network create coolify
- Dominio con registro DNS tipo Wildcard apuntando a la direccion IP del servidor (ejemplo: *.db.tudominio.com).

### 7.2 Variables de Entorno Fundamentales
En el archivo backend/.env de produccion, definir:

- MASTER_KEY: cadena hexadecimal de 64 caracteres generada criptograficamente.
- DATABASE_PUBLIC_DOMAIN: dominio raiz para los subdominios de bases de datos.
- DATABASE_PUBLIC_PROTOCOL: https
- CORS_ORIGIN: direccion URL publica donde se hospeda el panel frontend.
- ALLOW_PUBLIC_REGISTRATION: false (recomendado una vez registrado el usuario administrador principal).
- LIBSQL_ENABLE_NAMESPACES: true
- LIBSQL_ADMIN_URL: http://sqld:9090
- LIBSQL_INTERNAL_URL: http://sqld:8080

### 7.3 Persistencia de Volumenes
Asegurarse de que los volumenes montados en docker-compose.yml apunten a rutas con almacenamiento permanente y copias de seguridad activas:
- ./backend/data:/app/data (almacena control.db y configuraciones maestras).
- ./backend/data/sqld:/var/lib/sqld (almacena los namespaces y datos fisicos de sqld).

### 7.4 Politica de Respaldo
- Las copias de respaldo de bases de datos en caliente deben realizarse utilizando sentencias VACUUM INTO o herramientas de replicacion de transacciones como Litestream hacia almacenamiento en la nube (S3 o compatible).

---

## 8. Registro Cronologico de Cambios Tecnicos (Antes vs Despues)

### 8.1 Orquestacion del Monorepo
- Estado Anterior: El proyecto tenia configuraciones de paquetes y dependencias independientes entre backend y frontend, obligando a compilar por separado y provocando inconsistencias en las pruebas globales.
- Estado Actual: Se configuro un sistema de NPM Workspaces unificado en el package.json raiz. Un unico comando instala dependencias, ejecuta suites de prueba cruzadas y compila ambos servicios de manera reproducible.

### 8.2 Modelo de Aprovisionamiento Multitenancy
- Estado Anterior: Cada creacion de base de datos requeria levantar un contenedor Docker individual dependiente del socket del host, lo que saturaba la memoria RAM del servidor y demoraba entre 5 y 15 segundos por base de datos.
- Estado Actual: Se integro LibsqlNamespaceService interactuando con la Admin API interna de sqld. El aprovisionamiento se realiza en memoria en menos de 10 milisegundos y todo el almacenamiento se concentra en un unico proceso central de sqld.

### 8.3 Fuga de Memoria en la Subida de Bases de Datos
- Estado Anterior: La ruta proxy de Next.js procesaba las importaciones de archivos SQLite mediante request.arrayBuffer(), cargando todo el peso del archivo binario directamente en la memoria del servidor web y provocando fallos por memoria agotada (OOM).
- Estado Actual: Se reescribio el manejador proxy utilizando streaming directo (duplex: 'half'), transfiriendo el flujo de datos desde el navegador hacia el backend de Fastify sin acumulacion en la memoria de Node.js.

### 8.4 Resolucion de URLs para Clientes Remotos
- Estado Anterior: Las bases de datos locales no generaban URLs de conexion HTTP accesibles en el panel, mostrando unicamente rutas fisicas en disco (como /data/sqlite/...) no utilizables por SDKs externos.
- Estado Actual: Se actualizo connection-url.ts para que toda base de datos genere una URL de protocolo remota valida (http://localhost:3000/api/v1/databases/:id/), permitiendo copiar el snippet de conexion y el token de forma inmediata.

### 8.5 Validacion y Rechazo Estricto de Seguridad
- Estado Anterior: Los tokens se almacenaban sin estandarizacion de namespaces cruzados y faltaban cabeceras permitidas en CORS para peticiones autenticadas desde el navegador (X-CSRF-Token-V2, X-Database-ID).
- Estado Actual: Se generaron tokens criptograficos asimetricos Ed25519 con aislamiento estricto por namespace, se incorporaron las cabeceras requeridas en la politica CORS y se comprobo que cualquier token invalido es rechazado de inmediato con error 401 Unauthorized.

### 8.6 Eliminacion Definitiva y Limpieza de Recursos
- Estado Anterior: Al eliminar una base de datos desde el panel, el registro permanecia en la interfaz o no liberaba por completo los descriptores de archivo en caliente.
- Estado Actual: El metodo deleteDatabase purga las conexiones activas del ConnectionPool, elimina el namespace en sqld, borra los archivos fisicos en disco y actualiza el estado en la base de control.

### 8.7 Validacion E2E con Cliente Oficial de Turso
- Estado Anterior: No existia una prueba integral que validara la comunicacion de un backend externo consumiendo la base de datos a traves de la red como lo hace un usuario en produccion.
- Estado Actual: Se implemento demo-external-backend.mjs, verificando conexion remota con @libsql/client, ciclo CRUD completo (POST, GET, PUT, DELETE), operaciones batch atomicas y persistencia visible en la consola SQL Studio del panel web.


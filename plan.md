# Arquitectura Self-Hosted Tipo Turso

## 1. Propósito

Diseñar una plataforma autoalojada para administrar múltiples bases de datos desde un panel web propio, con capacidad de:

1. Registrar conexiones a distintas bases.
2. Guardar URLs y tokens de forma segura.
3. Crear nuevas bases SQLite administradas con `libsql`.
4. Exponer cada proyecto o base con su propio subdominio.
5. Administrar esquemas, consultas, migraciones y auditoría.
6. Ejecutarse en servidor local, VPS o Coolify.

El objetivo es tener una alternativa privada a Turso, pero bajo control total del usuario.

## 2. Alcance

### 2.1 Incluye

1. Panel web administrativo.
2. API backend segura.
3. Registro de múltiples bases de datos.
4. Cifrado de credenciales.
5. Autenticación y permisos.
6. Provisión de nuevas bases SQLite con `libsql`.
7. Generación de URLs/subdominios por proyecto.
8. Auditoría completa.

### 2.2 No incluye inicialmente

1. Facturación.
2. Replicación avanzada multi-región.
3. Alta disponibilidad compleja.
4. Soporte empresarial para múltiples proveedores cloud.

## 3. Arquitectura General

```text
Usuario
  -> Frontend Admin
  -> API Backend
  -> Control Plane
  -> Secret Store
  -> Data Plane
  -> Bases SQLite/libsql
```

### 3.1 Capas

1. `Frontend Admin`: interfaz visual.
2. `API Backend`: autenticación, negocio y orquestación.
3. `Domain Core`: reglas del sistema.
4. `Infrastructure`: persistencia, cifrado, drivers y despliegue.

### 3.2 Planos del sistema

1. `Control Plane`: usuarios, proyectos, permisos, sesiones, auditoría.
2. `Data Plane`: consultas, tablas, esquemas, migraciones, backups.
3. `Secret Plane`: URLs, tokens, llaves y credenciales cifradas.

## 4. Principios de diseño

1. Separar frontend, backend y motor de datos.
2. No exponer secretos al navegador.
3. Tratar cada base como un recurso administrado.
4. Mantener el dominio independiente de la infraestructura.
5. Diseñar por DDD para escalar sin reescribir.
6. Soportar local, VPS y Coolify con la misma base técnica.

## 5. DDD

### 5.1 Bounded Contexts

1. `Identity and Access`
2. `Project Management`
3. `Database Registry`
4. `Connection Management`
5. `Schema Management`
6. `Query Execution`
7. `Provisioning`
8. `Auditing`

### 5.2 Capas DDD

1. `Domain`
2. `Application`
3. `Infrastructure`
4. `Presentation`

### 5.3 Responsabilidad por capa

#### Domain

Contiene entidades, value objects, agregados y reglas puras.

#### Application

Contiene casos de uso y coordinación entre servicios.

#### Infrastructure

Contiene implementaciones concretas: BD, cifrado, logs, drivers, colas.

#### Presentation

Contiene HTTP controllers, validadores y UI.

## 6. Backend

### 6.1 Módulos

1. Auth.
2. Users.
3. Roles and Permissions.
4. Projects.
5. Databases.
6. Connections.
7. Provisioning.
8. Schema.
9. Queries.
10. Migrations.
11. Audit.
12. Settings.

### 6.2 Controladores

1. `AuthController`
2. `UsersController`
3. `ProjectsController`
4. `DatabasesController`
5. `ConnectionsController`
6. `ProvisioningController`
7. `SchemaController`
8. `QueryController`
9. `MigrationsController`
10. `AuditController`
11. `SettingsController`

### 6.3 Casos de uso

1. `LoginUser`
2. `RefreshSession`
3. `RegisterProject`
4. `RegisterDatabase`
5. `TestDatabaseConnection`
6. `ListDatabases`
7. `GetDatabaseSchema`
8. `ExecuteQuery`
9. `CreateProvisionedDatabase`
10. `RotateDatabaseToken`
11. `RevokeDatabaseAccess`

### 6.4 Endpoints base

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
GET    /api/v1/me

GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:id

GET    /api/v1/databases
POST   /api/v1/databases
GET    /api/v1/databases/:id
PATCH  /api/v1/databases/:id
DELETE /api/v1/databases/:id
POST   /api/v1/databases/:id/test-connection
POST   /api/v1/databases/:id/rotate-token

GET    /api/v1/databases/:id/schema
GET    /api/v1/databases/:id/tables/:table
POST   /api/v1/databases/:id/query
POST   /api/v1/databases/:id/migrations

POST   /api/v1/provisioning/sqlite
POST   /api/v1/provisioning/libsql

GET    /api/v1/audit
```

### 6.5 Estructura de carpetas sugerida

```text
src/
  main.ts
  config/
    env.ts
    auth.ts
    security.ts
    database.ts
  domain/
    identity/
    projects/
    databases/
    provisioning/
    auditing/
    shared/
  application/
    identity/
    projects/
    databases/
    provisioning/
    auditing/
  infrastructure/
    auth/
    crypto/
    persistence/
    databases/
    logging/
    jobs/
    storage/
  presentation/
    http/
      controllers/
      middlewares/
      validators/
      routes/
      presenters/
```

## 7. Frontend

### 7.1 Objetivo del frontend

Ofrecer una experiencia tipo panel de administración profesional para operar proyectos, bases y credenciales.

### 7.2 Páginas

1. Login.
2. Dashboard.
3. Projects.
4. Databases.
5. Database detail.
6. Schema browser.
7. Query editor.
8. Provisioning wizard.
9. Tokens and secrets.
10. Users and roles.
11. Audit log.
12. Settings.

### 7.3 Estructura de carpetas sugerida

```text
web/
  src/
    app/
    components/
    features/
      auth/
      dashboard/
      projects/
      databases/
      schema/
      query-editor/
      provisioning/
      settings/
      audit-log/
    shared/
      ui/
      hooks/
      lib/
      types/
      validators/
    routes/
    styles/
```

### 7.4 Componentes base

1. Table.
2. Search bar.
3. Form dialog.
4. Confirm modal.
5. Drawer detail.
6. SQL editor.
7. Status badge.
8. Database card.
9. Audit timeline.
10. Environment selector.

## 8. Multi-DB y libsql

### 8.1 Tipos de base soportados

1. SQLite local.
2. `libsql`.
3. `https` remota administrada.
4. Futuro: `postgres` y otros motores.

### 8.2 Datos que debe guardar cada conexión

1. Nombre.
2. Tipo de motor.
3. URL.
4. Token o credencial.
5. Estado.
6. Proyecto asociado.
7. Subdominio.
8. Fecha de creación.
9. Última validación.

### 8.3 Flujo de registro

1. El usuario crea un proyecto.
2. Registra una base o pide una nueva.
3. El backend valida formato y permisos.
4. El backend cifra y guarda los secretos.
5. El backend prueba la conexión.
6. Si todo funciona, activa la base en el panel.

### 8.4 Flujo de provisión

1. Crear proyecto.
2. Crear base SQLite/libsql.
3. Asignar nombre y subdominio.
4. Generar token.
5. Inicializar esquema.
6. Registrar endpoint.
7. Publicar la URL de conexión.

## 9. Seguridad

### 9.1 Autenticación

1. Login con usuario/email y password.
2. Hash fuerte (`argon2id` recomendado).
3. `access token` corto.
4. `refresh token` rotativo.
5. 2FA/TOTP para administradores.

### 9.2 Autorización

1. RBAC.
2. Permisos por recurso.
3. Roles sugeridos: superadmin, admin, operador, solo lectura.
4. Políticas por proyecto y base.

### 9.3 Secretos

1. Nunca guardar tokens en texto plano.
2. Cifrar con `MASTER_KEY`.
3. Mantener la llave maestra fuera del repositorio.
4. Permitir rotación y revocación.

### 9.4 API hardening

1. Rate limiting.
2. CORS restringido.
3. Headers de seguridad.
4. Validación obligatoria.
5. Logs sin datos sensibles.
6. CSRF si hay cookies de sesión.

## 10. Validaciones

Validar siempre en frontend y backend.

### Reglas mínimas

1. Email válido.
2. Password con complejidad mínima.
3. Subdominio único y normalizado.
4. URL válida.
5. Token no vacío.
6. Nombre obligatorio.
7. Motor permitido.
8. Query permitida según rol.

## 11. Auditoría y observabilidad

### 11.1 Auditoría

1. Quién hizo el cambio.
2. Cuándo lo hizo.
3. Desde qué IP.
4. Qué recurso cambió.
5. Valor anterior y nuevo.

### 11.2 Observabilidad

1. Logs estructurados.
2. Trazas por request.
3. Métricas de latencia.
4. Métricas de errores.
5. Estado de conexiones.

## 12. Despliegue

### 12.1 Entornos

1. Local.
2. VPS.
3. Coolify.

### 12.2 Componentes desplegables

1. `web`.
2. `api`.
3. `worker` opcional.
4. base interna de metadatos.
5. storage para backups.

### 12.3 Subdominios

1. `panel.midominio.com`.
2. `api.midominio.com`.
3. `admin.midominio.com`.
4. `*.midominio.com` para proyectos o bases.

### 12.4 Reglas operativas

1. Todo detrás de HTTPS.
2. Variables y secretos en Coolify o secret manager.
3. Backups automáticos.
4. Health checks.
5. Separación de entornos.

## 13. Esquema interno de metadatos

La plataforma necesita su propia base para administrar el sistema.

### Tablas sugeridas

1. `users`
2. `roles`
3. `permissions`
4. `user_roles`
5. `projects`
6. `databases`
7. `database_secrets`
8. `database_endpoints`
9. `sessions`
10. `api_tokens`
11. `audit_logs`
12. `provision_jobs`
13. `settings`

## 14. Roadmap

### Fase 1

1. Crear base interna.
2. Implementar auth y roles.
3. Registrar conexiones.
4. Cifrar secretos.

### Fase 2

1. Listado de bases.
2. Test de conexión.
3. Vista de esquema.
4. Query editor.
5. Auditoría.

### Fase 3

1. Provisión de nuevas bases con `libsql`.
2. Subdominios automáticos.
3. Rotación de tokens.
4. Health checks.

### Fase 4

1. Multi-entorno.
2. Backups automáticos.
3. Alta disponibilidad si aplica.
4. Soporte para más motores.

## 15. Resultado esperado

Una plataforma autoalojada, segura y escalable que permita administrar múltiples bases de datos, crear nuevas instancias SQLite/libsql, exponerlas por URL o subdominio y operar todo desde un panel propio, igual que un Turso privado.
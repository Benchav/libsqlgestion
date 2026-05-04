# Usage Guide

This guide explains how to use libsqlite in practice, from first deployment to daily operations.

## 1. What you are running

You are running a self-hosted control plane that manages:

- SQLite files on disk
- existing `.db` files imported from your server
- `.db` files discovered from a mounted directory
- remote libsql databases registered by URL and token

The control plane stores metadata, permissions, sessions, audit logs and migration history.

## 2. First deployment

### Backend

1. Copy `backend/.env.example` to `backend/.env`.
2. Set `MASTER_KEY` with 64 hex characters.
3. Set the storage and discovery paths.
4. Start the backend.

Example:

```bash
cd backend
npm install
npm run build
npm run start
```

### Frontend

1. Copy `frontend/.env.example` to `frontend/.env`.
2. Set `NEXT_PUBLIC_API_URL`.
3. Start the frontend.

Example:

```bash
cd frontend
npm install
npm run build
npm run start
```

## 3. Create the first administrator

The backend exposes:

- `POST /api/v1/auth/register`

Create the first user by sending email and password.

Example:

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"StrongPassword123!"}'
```

The response returns:

- user information
- `accessToken`
- `refreshToken`

Save the access token in the frontend or in your client.

## 4. Login

Use the same endpoint for normal authentication:

- `POST /api/v1/auth/login`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"StrongPassword123!"}'
```

## 5. Create a project

Projects are the ownership boundary for databases.

Endpoint:

- `POST /api/v1/projects`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/projects \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Billing"}'
```

Why projects matter:

- keep databases grouped by application or client
- simplify permissions
- simplify backup and filesystem layout

## 6. Create a new SQLite database

Endpoint:

- `POST /api/v1/databases`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/databases \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId":"<projectId>",
    "name":"billing-db",
    "type":"sqlite"
  }'
```

What happens:

- the control plane creates a metadata record
- a file is created in the structured storage tree
- a subdomain identifier is generated
- the database becomes active

Managed path example:

```text
data/sqlite/projects/<projectId>/databases/<databaseId>.db
```

## 7. Import an existing SQLite database

Use this when you already have a `.db` file on the server.

Endpoint:

- `POST /api/v1/databases/import-sqlite`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/databases/import-sqlite \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId":"<projectId>",
    "name":"legacy-db",
    "sourcePath":"/srv/uploads/legacy.db"
  }'
```

What happens:

- the file is copied into managed storage
- the database is registered in metadata
- the file is now managed like any other database

## 8. Discover existing `.db` files from a mounted folder

Use this when Coolify or your server mounts a folder containing SQLite files.

Configure:

- `SQLITE_DISCOVERY_PATH`
- `SQLITE_DISCOVERY_PROJECT_ID`
- optional `SQLITE_DISCOVERY_ADOPT=true`

Endpoint:

- `POST /api/v1/discovery/sqlite/scan`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/discovery/sqlite/scan \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId":"<projectId>",
    "rootPath":"/app/data/sqlite",
    "adopt":false
  }'
```

Two modes exist:

### Discover only

- records the file in metadata
- keeps the file where it already is

### Discover and adopt

- copies the file into the managed storage tree
- keeps all managed databases in one consistent hierarchy

Endpoint for adoption:

- `POST /api/v1/discovery/sqlite/adopt`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/discovery/sqlite/adopt \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId":"<projectId>",
    "rootPath":"/app/data/sqlite"
  }'
```

## 9. Register a libsql remote database

Use this for a remote libsql or Turso-compatible endpoint.

Endpoint:

- `POST /api/v1/provisioning/libsql`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/provisioning/libsql \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId":"<projectId>",
    "name":"remote-app-db",
    "url":"libsql://example.turso.io",
    "token":"<libsql-token>"
  }'
```

## 10. Inspect schema

Endpoint:

- `GET /api/v1/databases/:id/schema`

This shows:

- table names
- columns
- foreign keys

## 11. Run queries

Endpoint:

- `POST /api/v1/databases/:id/query`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/databases/<dbId>/query \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "sql":"SELECT * FROM users LIMIT 10",
    "params":[]
  }'
```

Rules:

- read queries are allowed for SQLite through the read path
- writes are allowed through the managed API with permission checks

## 12. Apply migrations

Endpoint:

- `POST /api/v1/databases/:id/migrations`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/databases/<dbId>/migrations \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"create-users-table",
    "sql":"CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);"
  }'
```

This is the recommended way to run schema changes from your codebase or CI.

## 13. Rotate tokens

Use:

- `PATCH /api/v1/databases/:id/rotate-token`

This is useful when:

- a credential may have been exposed
- a database is moving between environments
- you want to refresh access regularly

## 14. Audit and monitoring

Use:

- `GET /api/v1/audit`
- `GET /health`
- `GET /ready`

These endpoints help you verify:

- what changed
- whether the API is alive
- whether the database layer is ready

## 15. Recommended operational workflow

1. Create a project.
2. Create a SQLite database or import an existing one.
3. Or register a libsql endpoint.
4. Apply migrations from your code or CI.
5. Inspect schema and run queries when needed.
6. Use the audit log for traceability.
7. Backup the control-plane database and managed SQLite files.

## 16. Common mistakes

- forgetting to set `MASTER_KEY`
- mounting a directory but not setting `SQLITE_DISCOVERY_PATH`
- trying to manage a remote database without registering URL and token
- assuming the backend can guess arbitrary files on another machine

# API Reference

Base path: `/api/v1`

## Authentication

### `POST /auth/register`

Creates a user and returns access and refresh tokens.

Example body:

```json
{
  "email": "admin@example.com",
  "password": "StrongPassword123!"
}
```

### `POST /auth/login`

Authenticates a user and returns a session.

### `POST /auth/refresh`

Rotates the session using a refresh token.

### `POST /auth/logout`

Revokes the refresh token session.

### `GET /me`

Returns the authenticated user.

## Projects

### `GET /projects`

Lists accessible projects.

### `POST /projects`

Creates a new project.

### `GET /projects/:id`

Gets a single project.

## Databases

### `GET /databases`

Lists databases.

### `POST /databases`

Creates a managed database record.

Body fields:

- `projectId`
- `name`
- `type` (`sqlite`, `libsql`, `remote`)
- `url` optional for remote databases
- `token` optional
- `subdomain` optional

### `POST /databases/import-sqlite`

Imports an existing SQLite file from a server-side path.

### `GET /databases/:id`

Returns a single database record.

### `PATCH /databases/:id/rotate-token`

Rotates the stored token.

### `POST /databases/:id/test-connection`

Tests the registered connection.

## Schema and query

### `GET /databases/:id/schema`

Returns tables, columns and foreign keys.

### `POST /databases/:id/query`

Executes a query against the target database.

Request body:

```json
{
  "sql": "SELECT * FROM users LIMIT 10",
  "params": []
}
```

## Migrations

### `GET /databases/:id/migrations`

Lists migration history for a database.

### `POST /databases/:id/migrations`

Applies SQL migrations directly to a database.

Request body:

```json
{
  "name": "add-users-table",
  "sql": "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);"
}
```

## Provisioning

### `POST /provisioning/sqlite`

Creates a new SQLite database file and registers it.

### `POST /provisioning/libsql`

Registers a libsql database by URL and token.

## Discovery

### `POST /discovery/sqlite/scan`

Scans a mounted directory for `.db` files and registers them.

### `POST /discovery/sqlite/adopt`

Scans and adopts mounted `.db` files into the managed storage tree.

## Audit and health

### `GET /audit`

Lists audit records.

### `GET /health`

Returns service health.

### `GET /ready`

Returns readiness status.

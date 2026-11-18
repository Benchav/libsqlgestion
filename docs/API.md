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

Returns the authenticated user, roles and permissions. Password hashes and session tokens are never included.

### `PATCH /me/email`

Changes the current account email. Requires the current password.

```json
{ "email": "new@example.com", "currentPassword": "current-password" }
```

### `PATCH /me/password`

Changes the current account password. Requires the current password and revokes all other sessions while keeping the current one.

```json
{ "currentPassword": "current-password", "newPassword": "new-password" }
```

## Users

### `GET /users`

Lists users and their roles. Requires `users.read`. Responses exclude `passwordHash` and session data.

### `POST /users`

Creates another account with its own email and password. Requires `users.write`.

```json
{ "email": "operator@example.com", "password": "password", "roleName": "operator" }
```

Admins can assign `operator` and `readonly`; only superadmins can assign `admin` or `superadmin`.

### `PATCH /users/:id`

Updates another user's email, active state, or password. Requires `users.write`. Resetting a password revokes that user's sessions. Only a superadmin can modify a superadmin account.

## Projects

### `GET /projects`

Lists accessible projects. Each project includes `databaseCount`, the real
number of databases stored for that project.

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

With `LIBSQL_NAMESPACE_IMPORTS=false` (the Compose default), imports are stored as local `.db` files. Set `auto` to use the `sqld` namespace when it is reachable and fall back to local otherwise, or `true` to require the namespace.

### `GET /databases/:id`

Returns a single database record.

### `PATCH /databases/:id/rotate-token`

Rotates the stored token. The previous token is invalidated immediately; update every client that uses it.

### `POST /databases/:id/reveal-token`

Reveals the current token for an authorized administrator. It requires `databases.write`, checks project access, returns `Cache-Control: no-store`, and records a `database.reveal_token` audit entry. The token is never written to the logs.

### `POST /databases/:id/test-connection`

Tests the registered connection. Returns `503` with the failure details when the connection is not healthy.

### `POST /databases/:id/convert-to-local`

Repairs an existing `sqld-namespace` database by copying its file from the namespace volume into managed local storage. The database record is updated to `type: "sqlite"` and `runtime.provider: "local-file"`.

Use this when an import was registered as a namespace database but `sqld` is no longer available and the namespace file still exists on disk.

## Snapshots and restore points

Snapshots are available for `LOCAL-FILE` databases. Each snapshot is a full,
consistent SQLite copy created with `VACUUM INTO`. They provide restore points at
the configured interval (RPO equal to the snapshot interval); they are not
continuous WAL point-in-time recovery.

### `GET /databases/:id/snapshots`

Lists restore points, their sizes and the active snapshot engine policy. Use
`?before=<ISO timestamp>` to resolve a point-in-time restore; the result is the
nearest snapshot at or before that timestamp.

### `GET /databases/:id/snapshot-policy`

Returns the per-database backup policy. If the database has no saved policy, the
defaults are returned with `isDefault: true`.

### `PUT /databases/:id/snapshot-policy`

Saves a partial or complete policy:

```json
{
  "restorePointIntervalMinutes": 60,
  "dailyEnabled": true,
  "dailyAtHour": 2,
  "dailyRetention": 14,
  "weeklyEnabled": true,
  "weeklyDayOfWeek": 1,
  "weeklyAtHour": 2,
  "weeklyRetention": 8,
  "monthlyEnabled": true,
  "monthlyDayOfMonth": 1,
  "monthlyAtHour": 2,
  "monthlyRetention": 12,
  "timezone": "UTC"
}
```

`weeklyDayOfWeek` uses `0=Sunday` through `6=Saturday`. Hours are in the
configured IANA timezone.

### `POST /databases/:id/snapshots`

Creates a manual snapshot and marks it as pinned so automatic retention does not
remove it. Returns `201` with the snapshot record.

### `DELETE /databases/:id/snapshots/:snapshotId`

Deletes a snapshot and its file.

### `POST /databases/:id/snapshots/:snapshotId/restore`

Creates a **new database** from a snapshot. The source database is not modified.

Request body:

```json
{ "name": "insumosv1-restore-20261117" }
```

Returns `201` with the new database and its token. Clients must switch to the new
URL and token after verifying the data.

### `GET /databases/:id/snapshots/:snapshotId/download`

Downloads the snapshot file for offsite storage or manual recovery.

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

**Responses:**
- `200 OK`: Successful query execution.
- `400 Bad Request`: Missing `sql` parameter.
- `404 Not Found`: Database not found.
- `422 Unprocessable Entity`: SQL syntax error, constraint violation, or non-existent table/column.
- `503 Service Unavailable`: Database is currently locked (SQLITE_BUSY).
- `500 Internal Server Error`: Generic execution failure or corrupted database (SQLITE_CORRUPT).

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

**Notes on Migrations:**
- Migrations run inside a transaction (`BEGIN` ... `COMMIT` / `ROLLBACK`) for atomicity.
- SQL syntax supports string literals with internal semicolons without breaking splitting logic.

**Responses:**
- `201 Created`: Migration successfully applied.
- `400 Bad Request`: Missing name or SQL statements, or invalid name formatting.
- `422 Unprocessable Entity`: SQL syntax errors or constraints failing during migration execution.
- `404 Not Found`: Database not found.

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

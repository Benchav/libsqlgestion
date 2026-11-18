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
- `url` required for remote databases
- `token` optional
- `subdomain` optional
- `primaryMode` optional (`auto`, `namespace`, `runtime`) for managed libSQL primaries

With the libSQL-first policy (`LIBSQL_REQUIRE_PRIMARY=true`,
`LIBSQL_ALLOW_LOCAL_FILE=false`), `type=sqlite` is rejected and `type=libsql`
without a URL creates a real libSQL namespace or runtime. `type=remote` or
`type=libsql` with a URL registers an external libSQL primary.

### `POST /databases/import-sqlite`

Imports an existing SQLite file from a server-side path.

Body fields include `storageMode` (`auto`, `namespace`, `runtime`, or `local`).
With the default policy, imports must target a libSQL primary; `local` is only
allowed when `LIBSQL_ALLOW_LOCAL_FILE=true`. `auto` selects the configured
primary and never falls back to `LOCAL-FILE` when `LIBSQL_REQUIRE_PRIMARY=true`.

Server-side paths may belong to a live database, so they are copied with
`VACUUM INTO`.

### `POST /databases/import-upload`

Multipart upload of a `.db` file. Fields: `projectId`, optional `name`,
optional `subdomain`, `storageMode`, and `file`.

- Uploads are staged under `IMPORT_STAGING_DIR` (default: `<data>/tmp`).
- Uploaded files are already a closed snapshot, so they use a direct copy
  instead of `VACUUM INTO`, which roughly halves import I/O.
- The maximum size is `MAX_UPLOAD_SIZE_BYTES` (default 500 MB). Larger files
  should use the server-path endpoint.
- The response is returned after the primary accepts connections. Public route
  health is checked in the background, so DNS/TLS propagation does not block
  the import.

### `GET /databases/storage-capabilities`

Returns the available primary modes, public domain/protocol, whether the
legacy local-file escape hatch is enabled, and `maxUploadBytes`. The panel uses
it to build the create/import selectors and to explain why a mode is disabled.

### `GET /databases/:id`

Returns a single database record.

### `POST /databases/:id/health-check`

Re-checks the dedicated runtime's internal, backend and public URLs and stores
the result in `metadata.runtime.routeHealth`. It does not rotate the token. This
is used by the **Re-check** button in the database detail page.

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
  "sql": "SELECT * FROM users ORDER BY id",
  "params": [],
  "limit": 200,
  "offset": 0,
  "countTotal": true
}
```

`limit`, `offset` and `countTotal` are optional and designed for the Studio.
Read queries are always capped by `QUERY_HARD_MAX_ROWS` (default 1000) to
protect the API and browser. The response includes pagination metadata:

```json
{
  "ok": true,
  "rows": [],
  "rowsReturned": 200,
  "limit": 200,
  "offset": 0,
  "hasMore": true,
  "totalRows": 41426,
  "truncated": true,
  "durationMs": 42
}
```

`countTotal` runs an additional `COUNT(*)`; leave it false for polling clients.

**Responses:**
- `200 OK`: Successful query execution.
- `400 Bad Request`: Missing `sql` parameter.
- `404 Not Found`: Database not found.
- `422 Unprocessable Entity`: SQL syntax error, constraint violation, or non-existent table/column.
- `503 Service Unavailable`: Database is currently locked (SQLITE_BUSY).
- `504 Gateway Timeout`: Query exceeded `SQL_QUERY_TIMEOUT_MS`.
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

Legacy LOCAL-FILE provisioning. Under the libSQL-first policy
(`LIBSQL_ALLOW_LOCAL_FILE=false`) this endpoint is rejected with 403.

### `POST /provisioning/libsql`

Registers a libsql database by URL and token.

## Discovery

### `POST /discovery/sqlite/scan`

Scans a mounted directory for `.db` files. Under the libSQL-first policy this is
skipped because it would create LOCAL-FILE records. Import files through
`POST /databases/import-sqlite` with a libSQL `storageMode` instead.

### `POST /discovery/sqlite/adopt`

Same as scan; skipped under the libSQL-first policy.

## Analytics

### `GET /analytics`

Returns usage analytics for the selected period. Requires `analytics.read`.

Query parameters:

```text
range=today|7d|30d|month
from=<ISO timestamp>
to=<ISO timestamp>
```

The response includes:

- summary totals: queries, errors, error rate, rows read/written, average and
  p95 latency, storage, traffic bytes and database API request count,
- a zero-filled timeseries with queries, errors, rows, average/p95/max latency,
  traffic and storage,
- query source and HTTP status breakdowns,
- top databases and projects,
- top normalized queries ranked by latency, rows read, rows written and
  frequency,
- top error codes with redacted SQL previews.

When `from` and `to` are supplied, the window and its buckets use those exact
instants. The dashboard sends local-time boundaries so "Today" and "This month"
match the browser timezone. Without them, the server falls back to UTC.

SQL literals are redacted and never stored in analytics previews. Metrics are
collected from the moment the analytics-enabled backend starts. The raw
metrics retention is controlled by `ANALYTICS_RAW_RETENTION_DAYS`.

## Audit and health

### `GET /audit`

Lists audit records.

### `GET /health`

Returns service health.

### `GET /ready`

Returns readiness status.

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
- The panel compresses the file in the browser with gzip when
  `CompressionStream` is available and sends `x-upload-compression: gzip`.
  The backend decompresses it in-stream and enforces `MAX_UPLOAD_SIZE_BYTES`
  against the **decompressed** size.
- The maximum size is `MAX_UPLOAD_SIZE_BYTES` (default 500 MB). Larger files
  should use the server-path endpoint.
- The response is returned after the primary accepts connections. Public route
  health is checked in the background, so DNS/TLS propagation does not block
  the import.

### `GET /databases/storage-capabilities`

Returns the available primary modes, public domain/protocol, whether the
legacy local-file escape hatch is enabled, `maxUploadBytes`, and
`supportsUploadCompression`. The panel uses it to build the create/import
selectors, enable browser gzip compression, and explain why a mode is disabled.

### `GET /settings/public-database/dns-check`

Checks whether a wildcard DNS record exists for the configured database domain
(or the `domain` query parameter). It queries a random
`probe-<random>.<domain>` using public resolvers (1.1.1.1/8.8.8.8) with a
system-resolver fallback.

- `ok: true` includes the resolved addresses.
- `ok: false` with `record: "*.example.com"` means the wildcard record is
  missing. A wildcard on the parent domain does not cover a deeper subdomain.

This is used by **Settings → Public Database Routing → Test wildcard DNS**.

## Offsite snapshot backups (S3 / Cloudflare R2)

Configured from **Settings → Offsite Backups**. Requires `settings.read` to view
and `settings.write` to change. The secret access key is encrypted at rest and
is never returned.

### `GET /settings/offsite-backup`

Returns the public settings (without the secret), `secretAccessKeyConfigured`,
`secretSource` (`panel`, `env` or `none`) and upload status:

```json
{
  "settings": {
    "enabled": true,
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "bucket": "libsqlite-backups",
    "region": "auto",
    "prefix": "prod",
    "accessKeyId": "...",
    "secretAccessKeyConfigured": true,
    "secretSource": "panel",
    "uploadMode": "daily",
    "artifacts": "db",
    "retentionDays": 30,
    "required": false,
    "timeoutMs": 300000
  },
  "status": {
    "configured": true,
    "uploaded": 12,
    "pendingUploads": 0,
    "failedUploads": 0,
    "queued": 0,
    "lastUploadAt": "2026-11-19T07:51:00.000Z",
    "lastTestAt": "2026-11-19T07:45:00.000Z",
    "lastTestOk": true
  }
}
```

### `PUT /settings/offsite-backup`

Saves the configuration. If `secretAccessKey` is omitted or empty, the stored
secret is preserved. `clearSecret: true` removes the panel secret.

### `POST /settings/offsite-backup/test`

Tests the saved configuration against the bucket. Returns `ok`, `latencyMs`,
`bucket`, `endpoint` and `message`, or `502` with a sanitized error.

### `POST /settings/offsite-backup/sync`

Queues local snapshots for upload:

```json
{ "includeExisting": true, "limit": 25 }
```

- `includeExisting: false` only retries pending/failed snapshots.
- `includeExisting: true` backfills snapshots without an offsite copy.
- `snapshotId` queues one specific snapshot.

### `GET /databases/:id`

Returns a single database record. The response includes `blockReads`,
`blockWrites` and `deleteProtection` (all `false` by default). The encrypted
credential is never included.

### `PATCH /databases/:id/protection`

Updates one or more data-plane protection flags. Requires `databases.write` and
project access. At least one flag must be present:

```json
{
  "blockReads": true,
  "blockWrites": false,
  "deleteProtection": true
}
```

Behaviour:

- `blockReads` rejects statements that return rows (`SELECT`, read `PRAGMA`,
  `EXPLAIN`, and DML with `RETURNING`) and blocks the Studio, schema reads and
  database downloads. Automatic snapshots, restores and snapshot downloads
  remain available as administrative recovery operations, and health checks
  continue so recovery is still possible.
- `blockWrites` rejects DML, DDL, mutating PRAGMAs, `ATTACH`/`DETACH`,
  `VACUUM`, `ANALYZE` and `REINDEX`. Transaction control statements are allowed
  so an open transaction can be committed or rolled back.
- `deleteProtection` rejects `DELETE /databases/:id` and project deletion while
  any database in the project is protected.
- A blocked operation returns `403` with `DATABASE_READS_BLOCKED` or
  `DATABASE_WRITES_BLOCKED`. A blocked deletion returns `409` with
  `DATABASE_DELETE_PROTECTED`.
- Batches and sequences are preflighted as a whole: one forbidden statement
  rejects the request before any statement runs.
- These controls are enforced by the panel and its HTTP pipeline. For
  `sqld-namespace` and `docker-libsql`, clients connected directly to the public
  libSQL URL bypass the backend and are not covered unless they use the optional
  policy gateway described below.

### Policy gateway for direct libSQL clients

When `DATABASE_GATEWAY_ENABLED=true` and `GATEWAY_INTERNAL_TOKEN` is configured,
database responses include:

- `gatewayEnabled`
- `gatewayMode` (`path`, `root` or `none`)
- `gatewayHttpsUrl` (for example `https://db.example.com/gateway/`, or
  `https://db.example.com` in root mode)
- `gatewayLibsqlUrl` (for example `libsql://db.example.com/gateway/`, or
  `libsql://db.example.com` in root mode)

A client that uses the Gateway URL sends its Hrana requests through the policy
gateway. The gateway parses `execute`, `batch`, `sequence` and `store_sql`,
applies `blockReads`/`blockWrites`, and returns `403` before forwarding blocked
statements. It also rewrites any `base_url` from the runtime to `null` so the
client cannot switch to an internal URL and bypass the gateway.

In path mode the original direct URL remains available and still bypasses the
gateway. In root mode the existing host is routed through the gateway by
Traefik, with a backend deny route as a fallback. See
[POLICY_GATEWAY.md](POLICY_GATEWAY.md) for deployment, fail-closed behaviour and
the maintenance step required to remove the runtime's last-resort route.

The gateway obtains policy from:

```http
GET /api/v1/internal/gateway/policy?host=<database-host>
x-gateway-token: <GATEWAY_INTERNAL_TOKEN>
```

This endpoint is internal, token-protected and returns only the flags, provider
and internal upstream base URL. It never returns a database token.

Every change is recorded as `database.protection.update` with the previous and
new state.

### `POST /databases/:id/invalidate-tokens`

Rotates the database credential and returns the new token once. Requires
`databases.write` and project access. The response includes `scope`:

- `all` for `local-file` and `docker-libsql`. The previous token is rejected.
  Rotating a dedicated runtime recreates its container, so expect a short
  interruption.
- `panel-only` for `sqld-namespace`. The token used by the panel is rotated, but
  JWTs already issued directly against the shared sqld URL can remain valid
  until they expire. The response includes a `warning`.
- Externally managed and `remote` databases return `409` with
  `DATABASE_TOKEN_REVOCATION_UNSUPPORTED`.

The pipeline accepts only the token currently stored for the database; an old
token is rejected even if it was signed by the shared sqld key. After upgrading
from a build that accepted any namespace JWT, verify that every client using the
panel pipeline has the current token before relying on this behaviour.

### `POST /databases/:id/health-check`

Re-checks the dedicated runtime's internal, backend and public URLs and stores
the result in `metadata.runtime.routeHealth`. It does not rotate the token. This
is used by the **Re-check** button in the database detail page.

### `PATCH /databases/:id/rotate-token`

Rotates the stored token. The previous token is invalidated immediately for the
panel and its HTTP pipeline; update every client that uses it. For shared
`sqld-namespace` databases, tokens used directly against the sqld URL may remain
valid until they expire. Use `POST /databases/:id/invalidate-tokens` for the
provider-aware action and warnings.

### `POST /databases/:id/reveal-token`

Reveals the current token for an authorized administrator. It requires `databases.write`, checks project access, returns `Cache-Control: no-store`, and records a `database.reveal_token` audit entry. The token is never written to the logs.

### `POST /databases/:id/test-connection`

Tests the registered connection. Returns `503` with the failure details when the connection is not healthy.

### `POST /databases/:id/convert-to-local`

Repairs an existing `sqld-namespace` database by copying its file from the namespace volume into managed local storage. The database record is updated to `type: "sqlite"` and `runtime.provider: "local-file"`.

Use this when an import was registered as a namespace database but `sqld` is no longer available and the namespace file still exists on disk.

## Snapshots and restore points

Snapshots are available for local SQLite databases and managed libSQL primaries.
Local SQLite snapshots are full copies created with `VACUUM INTO`. libSQL
snapshots use the engine's `/dump` endpoint and, by default, keep the verified
SQLite export (`.db`) that was materialized from the dump. They provide restore
points at the configured interval (RPO equal to the snapshot interval); they are
not continuous WAL point-in-time recovery.

Snapshot records expose `format` (`sqlite`, `libsql-sql-dump` or
`libsql-sqlite-export`), `verified`, `downloadFormats`, `sizeBytes` (primary
artifact), `totalSizeBytes` (all retained artifacts), an optional `warning` and
`offsite` (`status`, `uploadedAt`, `attempts`, `lastError`). The list response
also includes `offsiteConfigured` so the panel only offers the upload action
when S3/R2 is configured.

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
remove it. libSQL snapshots return `202` with a pending record and finish in the
background; poll the list until `status` is `ready`. Returns `201` for local
SQLite.

### `DELETE /databases/:id/snapshots/:snapshotId`

Deletes every local artifact that belongs to the snapshot (`.db`, retained
`.sql` and sidecars). Returns `409` while a restore, download or offsite upload
is using the snapshot. Offsite copies are **not** deleted by this endpoint.

### `POST /databases/:id/snapshots/:snapshotId/offsite`

Queues a snapshot for an offsite upload. Requires `databases.write` and a
configured/enabled offsite bucket. Returns `202` with the updated snapshot.
Returns `409` when offsite is disabled or the snapshot is not ready.

### `POST /databases/:id/snapshots/:snapshotId/restore`

Creates a **new database** from a snapshot. The source database is not modified.

Request body:

```json
{
  "name": "insumosv1-restore-20261117",
  "artifactFormat": "db"
}
```

`artifactFormat` is optional (`db` or `sql`). By default the verified `.db` is
preferred; a snapshot that stores only `.sql` replays it. Use `"sql"` as an
escape hatch when the SQLite export is suspected to be corrupt. A missing or
unretained artifact returns `409`, as does a checksum mismatch.

Returns `201` with the new database and its token. Clients must switch to the new
URL and token after verifying the data.

### `GET /databases/:id/snapshots/:snapshotId/download`

Downloads the preferred snapshot artifact for offsite storage or manual
recovery: `.db` when available, otherwise `.sql`. Use `?format=db` or
`?format=sql` to select explicitly. The response includes `Content-Length` and
the correct SQLite or SQL media type. Invalid/absent combinations return `409`
or `404`.

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
databaseId=<database UUID>   # optional
```

The response includes:

- `databaseId` and `database`: the selected database metadata, or `null` when
  the response aggregates every database,
- summary totals: queries, errors, error rate, read/write query counts,
  read/write row counts, read/write ratio, rows per query/write, active/total
  databases, average/p95/max latency, storage, traffic bytes and request count,
- a zero-filled timeseries with total/read/write queries, errors, rows,
  average/p95/max latency, traffic and storage,
- operation mix (`select`, `insert`, `update`, `delete`, `replace`, `pragma`, `other`),
- query source and HTTP status breakdowns,
- `databaseUsage`: every existing database, including databases with zero
  captured traffic. Each row includes project, status, type, runtime provider,
  read/write queries, rows, errors, p95, storage, last activity, `lastSource`
  and `hasActivity`,
- `topDatabases`: backwards-compatible active-only subset of `databaseUsage`,
- top existing projects with read/write usage,
- top normalized queries ranked by latency, rows read, rows written and
  frequency,
- top error codes with redacted SQL previews.

When `databaseId` is provided, every aggregate and timeseries is filtered to
that database, while `databaseUsage` still describes all existing databases so
the UI can keep its selector populated. An unknown database ID returns `422`.

Deleted databases are excluded from every aggregate, including summaries,
timeseries, `databaseUsage`, top databases, top projects, top queries and
errors. Their raw rows remain in the analytics tables until retention removes
them, but they are never returned by the API.

When `from` and `to` are supplied, the window and its buckets use those exact
instants. The dashboard sends local-time boundaries so "Today" and "This month"
match the browser timezone. Without them, the server falls back to UTC.

### `GET /analytics/dashboard`

Compact payload for the dashboard. Requires `analytics.read` and accepts the
same query parameters as `GET /analytics`, including `databaseId`. It returns
the summary, timeseries, operation mix, the full `databaseUsage` inventory and
the top five active databases. It does not compute the expensive top-query or
error breakdowns.

### `POST /internal/gateway/analytics`

Internal, token-protected endpoint used by the policy gateway to ingest usage
from direct `libsql://` clients. It is not part of the public API and requires
`x-gateway-token` matching `GATEWAY_INTERNAL_TOKEN`. Only existing database IDs
are accepted; unknown or deleted IDs are ignored.

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

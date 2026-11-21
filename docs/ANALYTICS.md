# Usage Analytics

LibSQLite collects usage from the control-plane API, the panel's libSQL
pipeline, the Studio and the policy gateway. The analytics UI is built on the
same data for every source, so read/write usage is comparable across the panel
and the ERP.

## Data sources

| Source | Captured by | Typical traffic |
| --- | --- | --- |
| `api` | `POST /databases/:id/query` | Panel queries and integrations |
| `pipeline` | Backend Hrana pipeline | Studio and HTTP libSQL clients that use the backend URL |
| `studio` | Studio query calls | Interactive SQL editor |
| `migration` | Migration runners | Schema changes |
| `gateway` | Policy gateway ingest | Direct `libsql://` clients such as the ERP |

The gateway source is what makes direct ERP traffic visible. Without it, the
panel only sees queries that pass through the backend.

## Definitions

- **Queries**: one row in `query_metrics` per executed statement.
- **Read query**: `operation = select` (including `WITH ... SELECT`).
- **Write query**: `operation in (insert, update, delete, replace)`. CTE writes
  (`WITH ... INSERT/UPDATE/DELETE`) are classified by their main statement, not
  by the leading `WITH`.
- **Rows read**: rows returned by the runtime (`rows.length`). This is not the
  number of rows scanned internally by SQLite.
- **Rows written**: affected rows reported by the runtime
  (`affected_row_count`).
- **P95 latency**: 95th percentile of statement duration in the selected
  window.
- **Error rate**: failed statements divided by total statements.
- **Read/write ratio**: read queries divided by write queries. `—` means there
  were no write queries in the window.
- **Active database**: an existing database with at least one statement in the
  window.
- **Last source**: the most recent SQL query source captured for a database
  (`gateway`, `pipeline`, `api`, `studio`, `migration`) or `null` when there is
  no captured SQL.
- **HTTP request**: one row in `traffic_metrics`. It can come from the panel,
  the API, the gateway health check or a libSQL HTTP request.
- **SQL query**: one row in `query_metrics`. Only statements that reach the
  runtime produce query metrics.

## SQL vs HTTP

SQL queries, HTTP traffic and storage are independent signals:

| Signal | Table | What it means |
| --- | --- | --- |
| SQL queries | `query_metrics` | Executed statements and row counts |
| HTTP requests | `traffic_metrics` | Panel/API/gateway requests and bytes |
| Storage | `storage_samples` | Hourly database size |

A database can therefore have storage and HTTP traffic but `0` SQL queries.
This is common when:

- the panel loads the database detail/schema;
- the runtime or gateway performs `/health` checks;
- an external ERP uses the direct URL without the policy gateway.

`databaseUsage` exposes both `hasActivity` (SQL) and `hasHttpActivity` (HTTP),
plus `httpRequests`, `lastRequestAt` and `lastRequestPath`. The selected database
view shows a **Capture diagnostics** panel with SQL queries, HTTP requests,
last SQL source, last HTTP path and storage, so a zero-query database is not
confused with an offline database.

## Database inventory and filtering

The analytics response includes `databaseUsage`, built from `databases` with a
`LEFT JOIN` to `query_metrics`. This is deliberately different from a top-N
query:

- every existing database appears, even if it has zero captured traffic;
- deleted databases never appear because their row no longer exists;
- each row includes `hasActivity`, `lastSource` and `lastSeenAt`;
- zero-usage rows remain visible with zeros and a `No traffic captured` state.

When `databaseId` is supplied to `GET /analytics` or
`GET /analytics/dashboard`, every aggregate and timeseries is filtered to that
database. `databaseUsage` still contains the full inventory so the selector and
comparison chart remain populated. The Analytics page exposes this as:

- a database selector in the header (`All databases` or a specific database);
- a full-width **Database usage** table with all real databases;
- a **Database comparison** chart showing read/write rows for every database;
- a selected-database header with project, status, runtime provider and a
  `No traffic captured` warning when applicable.

The page also accepts a deep link:

```text
/analytics?databaseId=<database-uuid>
```

The dashboard's database usage rows use this link to open the selected
database directly.

If a real database shows zero usage, the database exists but no query reached
the backend or gateway in the selected period. For an ERP connected directly by
`libsql://`, the root-mode or `/gateway/` cutover must be active for its traffic
to be captured.

## Deleted databases

Deleting a database removes its row from `databases`, but historical metric
rows remain until the analytics retention job removes them. Every analytics
query joins the `databases` table, so deleted or unknown database IDs are
excluded from:

- summary totals and timeseries
- operation mix
- `databaseUsage`, top databases and top projects
- top queries
- top errors
- storage totals

The dashboard never shows a `Deleted` badge because those rows are filtered
before the response is built.

## Gateway ingest

Direct libSQL traffic is proxied by the policy gateway, which buffers metrics
and posts them to:

```http
POST /api/v1/internal/gateway/analytics
x-gateway-token: <GATEWAY_INTERNAL_TOKEN>
```

The endpoint validates existing database IDs, forces `source = gateway` and
enqueues the metrics through the normal analytics collector. It is exempt from
CSRF because it is token-authenticated and never uses browser cookies.

The gateway buffers up to `GATEWAY_ANALYTICS_MAX_QUEUE` metrics and flushes every
`GATEWAY_ANALYTICS_FLUSH_MS`. Flushes are best-effort: if the backend is down,
SQL traffic continues and metrics are retried until the queue is full.

SQL literals are redacted in the gateway before the payload is sent. The
backend stores only the normalized preview and fingerprint, never parameter
values or row data.

## API

- `GET /analytics?range=...&databaseId=<uuid>` — full analytics payload for the
  Analytics page. `databaseId` is optional.
- `GET /analytics/dashboard?range=...&databaseId=<uuid>` — compact payload for
  the dashboard.
- Both require the `analytics.read` permission.
- `POST /internal/gateway/analytics` — internal gateway ingest; not for browser
  or public use.

See [API.md](API.md) for the response fields and query parameters.

## Retention

Controlled by the backend environment:

```dotenv
ANALYTICS_ENABLED=true
ANALYTICS_RAW_RETENTION_DAYS=14
ANALYTICS_FLUSH_INTERVAL_MS=1000
ANALYTICS_MAX_QUEUE=10000
ANALYTICS_STORAGE_SAMPLE_MINUTES=60
ANALYTICS_STORAGE_RETENTION_DAYS=90
ANALYTICS_TRAFFIC_ENABLED=true
```

## Troubleshooting

**No `Gateway (ERP)` source appears.**

1. Confirm `GATEWAY_ANALYTICS_ENABLED=true` on the gateway.
2. Confirm `GATEWAY_INTERNAL_TOKEN` is the same on backend and gateway.
3. Call `GET /gateway/__health` and verify the gateway is in front of the
   database.
4. Check the gateway logs for `analytics flush failed`.
5. Confirm the ERP is not using an embedded replica; local reads never reach the
   gateway.

**Only one database appears in Database usage.**

`databaseUsage` starts from the `databases` table, so every existing row must
appear. Verify the deployed backend includes this version and that the browser
is not serving a cached page. The Analytics page uses the full inventory, not
`topDatabases`.

**A real database appears with zero SQL usage.**

The database exists, but no SQL statements were captured for it in the selected
period. Check the **Capture diagnostics** panel:

- **HTTP requests > 0, SQL queries = 0** means the database is reachable, but
  only non-SQL traffic was captured (health checks, panel requests, etc.). If an
  external client uses it directly, route it through the policy gateway (root
  mode or `/gateway/`).
- **HTTP requests = 0 and SQL queries = 0** means nothing reached the backend or
  gateway in the period.

The `Source` column shows `HTTP only` when HTTP traffic exists without SQL, and
`No traffic` only when neither exists.

**A deleted database still appears.**

The API should filter it. Verify the deployed backend includes the analytics
JOIN changes and that the browser is not serving a cached page. Raw historical
rows are expected in SQLite until retention removes them.

**Counts look lower than expected.**

Only statements that reach the runtime contribute rows read/written.
Gateway-blocked operations are rejected before the runtime and are not counted
as usage. Panel/API queries blocked by the protection layer are recorded as
failed queries. Gateway metrics are best-effort, so a prolonged backend outage
can drop buffered samples.

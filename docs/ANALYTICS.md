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

## Deleted databases

Deleting a database removes its row from `databases`, but historical metric
rows remain until the analytics retention job removes them. Every analytics
query joins the `databases` table, so deleted or unknown database IDs are
excluded from:

- summary totals and timeseries
- operation mix
- top databases and top projects
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

- `GET /analytics` — full analytics payload for the Analytics page.
- `GET /analytics/dashboard` — compact payload for the dashboard.
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

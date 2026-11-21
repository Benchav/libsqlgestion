# Coolify Deployment Guide

This project is designed to run as a Docker app in Coolify. The backend manages SQLite files and libsql connections, and it can also discover or adopt `.db` files mounted from the server.

For the full end-to-end setup, including Cloudflare DNS, wildcard subdomains, and API integration examples, see [docs/PUBLIC_DATABASES.md](docs/PUBLIC_DATABASES.md).
The panel also manages public database routing directly, so the Coolify env vars act as bootstrap defaults and fallback values..

## 1. Recommended topology

- `backend` service: API + control plane.
- Optional `frontend` service later: admin panel.
- Persistent volume for SQLite control data and managed database files.
- Wildcard subdomain through your reverse proxy or Coolify routing.
- If you want to replace Turso completely, publish the managed libSQL runtime through a public hostname that you configure in Coolify, such as `db.example.com` or `*.db.example.com`.
- Keep real domains and tokens out of the repository; set them only in Coolify environment variables or the panel.

## 2. Coolify service setup

Create a new Docker application in Coolify using the backend repository.

Use these settings:

- Build context: repository root or `backend/` depending on how you wire the app in Coolify.
- Dockerfile: `backend/Dockerfile`
- Exposed port: `3000`
- Health check path: `/health`
- If you are using Cloudflare Tunnel, make sure the hostname you expose for database traffic is reachable from your ERP and from the machine where you run migrations.

## 3. Environment variables

Set these in Coolify:

```env
MASTER_KEY=<64 hex chars>
DATABASE_FILE=/app/data/control.db
PORT=3000
CORS_ORIGIN=https://panel.tudominio.com
SQLITE_STORAGE_ROOT=/app/data/sqlite
SQLITE_DISCOVERY_PATH=/app/data/sqlite
SQLITE_DISCOVERY_PROJECT_ID=<project-id>
SQLITE_DISCOVERY_ADOPT=true
DATABASE_PUBLIC_DOMAIN=db.example.com
DATABASE_PUBLIC_URL_TEMPLATE=
DATABASE_PUBLIC_BASE_URL=
DATABASE_PUBLIC_HOST=db.example.com
ALLOW_PUBLIC_REGISTRATION=false
SQLITE_PERFORMANCE_PROFILE=performance
DB_CONNECTION_POOL_MAX_SIZE=256
DB_CONNECTION_POOL_IDLE_TTL_MS=1800000
SQL_QUERY_TIMEOUT_MS=15000
QUERY_HARD_MAX_ROWS=1000
ANALYTICS_ENABLED=true
ANALYTICS_TRAFFIC_ENABLED=true
LIBSQL_RUNTIME_TOKEN_TTL_SECONDS=2592000
LIBSQL_RUNTIME_MEMORY_BYTES=0
LIBSQL_RUNTIME_CPU_NANO=0
LIBSQL_RUNTIME_PIDS_LIMIT=0
MAX_UPLOAD_SIZE_BYTES=524288000
IMPORT_STAGING_DIR=/app/data/tmp

# Scheduled snapshots / restore points (SQLite + managed libSQL primaries)
SNAPSHOTS_ENABLED=true
SNAPSHOT_LIBSQL_ENABLED=true
SNAPSHOT_LIBSQL_VERIFY_REPLAY=true
# auto | sqlite | both | dump. `auto` stores a verified .db by default.
SNAPSHOT_LIBSQL_ARTIFACT=auto
SNAPSHOT_LIBSQL_MAX_BYTES=10737418240
SNAPSHOT_LIBSQL_DUMP_TIMEOUT_MS=900000
SNAPSHOT_INTERVAL_MINUTES=60
SNAPSHOT_FULL_WINDOW_HOURS=24
SNAPSHOT_SIX_HOURLY_WINDOW_HOURS=72
SNAPSHOT_RETENTION_DAYS=14
SNAPSHOT_SCHEDULER_TICK_MINUTES=5
SNAPSHOT_TIMEZONE=UTC
SNAPSHOT_MIN_FREE_BYTES=1073741824
SNAPSHOT_STALE_MINUTES=30
SNAPSHOT_VERIFY_ON_RESTORE=true

# Optional policy gateway for direct libSQL clients. Keep disabled until the
# gateway service and the /gateway Traefik route are deployed.
DATABASE_GATEWAY_ENABLED=false
DATABASE_GATEWAY_PATH=/gateway/
DATABASE_GATEWAY_ROOT_HOST=
GATEWAY_ALLOW_ROOT=false
GATEWAY_INTERNAL_TOKEN=
GATEWAY_BACKEND_INTERNAL_URL=http://backend:5000
GATEWAY_BODY_LIMIT_BYTES=33554432
GATEWAY_POLICY_TTL_MS=1000
GATEWAY_POLICY_MAX_STALE_MS=5000
GATEWAY_UPSTREAM_TIMEOUT_MS=120000
GATEWAY_LOG_REQUESTS=false

# Optional: offsite S3/R2 bootstrap defaults. Prefer Settings -> Offsite
# Backups in the panel; panel values override these variables.
SNAPSHOT_OFFSITE_ENABLED=false
SNAPSHOT_OFFSITE_ENDPOINT=
SNAPSHOT_OFFSITE_BUCKET=
SNAPSHOT_OFFSITE_REGION=auto
SNAPSHOT_OFFSITE_PREFIX=libsqlite
SNAPSHOT_OFFSITE_UPLOAD_MODE=daily
SNAPSHOT_OFFSITE_ARTIFACTS=db
SNAPSHOT_OFFSITE_RETENTION_DAYS=30
SNAPSHOT_OFFSITE_TIMEOUT_MS=300000

# Performance and persistent runtime health
SCHEMA_CACHE_TTL_MS=60000
SCHEMA_CACHE_MAX_ENTRIES=200
SQLITE_READ_POOL_SIZE=4
METRICS_CACHE_TTL_MS=5000
RUNTIME_HEALTH_INTERVAL_MINUTES=10
RUNTIME_HEALTH_PUBLIC_TIMEOUT_MS=5000
RUNTIME_HEALTH_STARTUP_DELAY_SECONDS=20
RUNTIME_HEALTH_CONCURRENCY=4

# libSQL-first policy (new databases/imports are real libSQL primaries)
LIBSQL_REQUIRE_PRIMARY=true
LIBSQL_ALLOW_LOCAL_FILE=false
LIBSQL_PRIMARY_MODE=auto
LIBSQL_CONVERSION_MODE=auto

# Shared sqld namespace
LIBSQL_NAMESPACE_PUBLIC_ENABLED=false
# Exact public host for a single namespace; first label must match the namespace
LIBSQL_NAMESPACE_HOST=

# Traefik TLS for dedicated runtimes or the exact shared-namespace router
TRAEFIK_CERT_RESOLVER=
TRAEFIK_ENTRYPOINT=https
# Docker network shared by backend, Traefik and runtime containers
LIBSQL_RUNTIME_NETWORK=coolify
LIBSQL_BACKEND_CONTAINER_ID=
# DNS-01 resolver for the optional wildcard namespace override
TRAEFIK_WILDCARD_CERT_RESOLVER=

# Legacy auto behavior, only used when LIBSQL_REQUIRE_PRIMARY=false
LIBSQL_NAMESPACE_IMPORTS=false
LIBSQL_IMPORT_RUNTIME=false
```

Notes:

- `MASTER_KEY` must be 64 hex characters.
- `SQLITE_STORAGE_ROOT` is where managed SQLite files are written.
- `SQLITE_DISCOVERY_PATH` is the directory the backend scans for existing `.db` files.
- `SQLITE_DISCOVERY_ADOPT=true` copies discovered databases into the managed storage tree so everything stays unified.
- `DATABASE_PUBLIC_DOMAIN` is the simplest option for wildcard subdomains such as `db.example.com`, which becomes `https://<subdomain>.db.example.com`.
- `DATABASE_PUBLIC_URL_TEMPLATE` is still available if you need a custom URL pattern.
- `DATABASE_PUBLIC_BASE_URL` is optional if you prefer path-based URLs.
- `DATABASE_PUBLIC_HOST` must resolve to the same host your ERP or editor will use when opening the database connection.
- `ALLOW_PUBLIC_REGISTRATION=false` is recommended after the first admin is created.
- `SQLITE_PERFORMANCE_PROFILE=performance` is the fastest starting point for local self-hosted ERP-style workloads.
- `DB_CONNECTION_POOL_*` controls backend connection reuse and eviction.
- `SQL_QUERY_TIMEOUT_MS` cancels long read queries; `QUERY_HARD_MAX_ROWS` caps API/Studio result sets.
- `SNAPSHOT_*` controls scheduled restore points for SQLite files and managed libSQL primaries. libSQL uses the engine's `/dump` endpoint, replays it into a standalone SQLite file, verifies integrity from a fresh connection, and stores SHA-256 checksums. `SNAPSHOT_LIBSQL_ARTIFACT=auto` (default) stores the verified `.db`; use `both` for a transitional rollout that keeps the legacy `.sql` and the `.db`, or `dump` to roll back behavior without a code downgrade. The scheduler ticks every 5 minutes and applies each database's editable restore-point/daily/weekly/monthly policy. Snapshots live under `/app/data/sqlite/snapshots`. Configure **Settings → Offsite Backups** to copy finished snapshots to Cloudflare R2 or another S3-compatible bucket; local snapshots alone are not disaster recovery. See [docs/BACKUP_AND_MIGRATION.md](docs/BACKUP_AND_MIGRATION.md).
- `LIBSQL_RUNTIME_*` lets you apply runtime CPU, memory and PID limits per managed database.
- `MAX_UPLOAD_SIZE_BYTES` caps browser imports. The panel gzip-compresses in the browser when supported; the limit applies to the decompressed database. Larger databases should be placed on the server and imported through **Server path**.
- `IMPORT_STAGING_DIR` must stay on the `/app/data` volume so uploads are not copied across filesystems. It defaults to `<data>/tmp`.
- `LIBSQL_RUNTIME_NETWORK=coolify` puts dynamically created libSQL runtimes on the same Docker network as the backend and Traefik. Leave it empty to detect a network shared with `coolify-proxy`; detection prefers `coolify`. The runtime is never silently created on the default `bridge` network because internal DNS and Traefik routing fail there.
- `LIBSQL_PROXY_CONTAINER_NAME` defaults to `coolify-proxy`; the backend uses it to verify that the runtime and proxy share a network.
- `LIBSQL_BACKEND_CONTAINER_ID` is only needed when `HOSTNAME`/`os.hostname()` cannot identify the backend container. A dedicated runtime is recreated through **Create new token**, so existing runtimes created on `bridge` must be rotated to pick up the correct network.
- `LIBSQL_REQUIRE_PRIMARY=true` blocks new `LOCAL-FILE` databases when no libSQL primary is available. It does not affect existing legacy databases.
- `LIBSQL_ALLOW_LOCAL_FILE=true` is the hidden escape hatch for legacy local files; keep it false for Turso-like behavior.
- `LIBSQL_PRIMARY_MODE=auto` prefers the shared namespace when `LIBSQL_NAMESPACE_PUBLIC_ENABLED=true` and `sqld` is reachable; otherwise it uses a dedicated runtime.
- If you enable `LIBSQL_ADMIN_URL` or `LIBSQL_ENABLE_NAMESPACES=true`, the `sqld` container must exist, be reachable as `sqld` from the backend, and share the same `/var/lib/sqld` volume.
- If you use `sqld` namespaces, set **both** `DATABASE_PUBLIC_DOMAIN` and `SQLD_PUBLIC_DOMAIN` to a dedicated parent domain for databases (for example `db.example.com`) and keep that domain separate from the domains used by applications.
- For many namespaces, use `docker-compose.wildcard.yml` with a DNS-01 wildcard resolver and set `LIBSQL_NAMESPACE_PUBLIC_ENABLED=true`. For one namespace, use the exact `LIBSQL_NAMESPACE_HOST` router.
- For an embedded replica against a shared namespace, the namespace URL must be host-based (`libsql://erp-db.data.example.com`). The `/dev/<namespace>/` path is only for HTTP pipeline clients.
- Migrate existing `LOCAL-FILE` databases with `npm --prefix backend run migrate:local-to-primary -- --mode=runtime --dry-run` and then `--apply`; use `--mode=namespace` after wildcard routing is ready.
- For legacy `LOCAL-FILE` databases, set `DATABASE_PUBLIC_BASE_URL` (or the panel's **Base URL** field) to the public HTTPS base URL of the backend so the generated URL is reachable by external clients.
- The panel should remain the source of truth for URL, token, and runtime details; the repository should only ship placeholders.

## 4. Volumes

Mount persistent storage for:

- `/app/data`

Recommended host structure on Ubuntu:

```text
/srv/libsqlite/
  control.db
  sqlite/
    projects/
      <projectId>/
        databases/
          <databaseId>.db
```

If you already have existing `.db` files on the server, mount them into a separate read/write folder first, then use discovery or adoption.

## 5. Discovery and adoption flow

You have two safe modes:

### A. Discover only

- Mount a directory with existing `.db` files.
- Set `SQLITE_DISCOVERY_PATH`.
- Call the discovery endpoint or let startup scan it.
- The system registers the databases but leaves the physical files where they are.

### B. Discover and adopt

- Mount a directory with existing `.db` files.
- Set `SQLITE_DISCOVERY_PATH` and `SQLITE_DISCOVERY_ADOPT=true`.
- The backend copies the files into the managed storage tree:
  `data/sqlite/projects/<projectId>/databases/<databaseId>.db`
- After adoption, all managed files stay under one consistent hierarchy.

## 6. Subdomains

The backend generates a `subdomain` identifier for each database record.

Use your reverse proxy or Coolify routing to map:

- `panel.tudominio.com` -> backend/admin panel
- `api.tudominio.com` -> backend API
- `*.tudominio.com` -> optional per-database routing if you want database-specific hostnames

For a Turso-like experience, dedicate a separate database hostname such as `db.example.com` and route the per-database URLs there.

The database subdomain is metadata in the control plane; routing is handled by Coolify or your proxy layer.

In the create/import dialogs, leave the subdomain field blank to let the backend auto-generate a public subdomain.

## 7. Migraciones desde código

To apply migrations without entering the panel:

1. Register or import the database.
2. Use the database URL and token from the control plane.
3. Call:

```text
POST /api/v1/databases/:id/migrations
```

This works for:

- local SQLite files managed by the backend
- libsql remote databases registered with URL + token

## 8. Policy gateway for direct libSQL clients

If the ERP connects directly to `libsql://`, the panel switches only cover the
panel unless you enable the policy gateway.

1. Set a long random `GATEWAY_INTERNAL_TOKEN` in the environment. Use the same
   value for the backend and the gateway service.
2. Set `DATABASE_GATEWAY_ENABLED=true` on the backend.
3. Add a gateway service that runs the backend image with:

   ```text
   node dist/gateway/main.js
   ```

   and expose port `8081` internally.
4. Route `/gateway` on the database hosts to that service. The provided
   `docker-compose.yml` already contains a `gateway` service and a
   `PathPrefix('/gateway')` Traefik router.
5. **Option A — Gateway path:** open the database detail page and copy the
   **Gateway URL**, then use it in the ERP:

   ```env
   TURSO_DATABASE_URL=libsql://<database-host>/gateway/
   TURSO_AUTH_TOKEN=<same token>
   ```

   Update `TURSO_SYNC_URL` too if it is configured.

6. **Option B — Root mode, keeping the existing URL:** set
   `GATEWAY_ALLOW_ROOT=true` and
   `DATABASE_GATEWAY_ROOT_HOST=<database-host>` on the backend, then deploy
   `docker-compose.gateway-root.yml` together with the main compose file. The
   override adds a gateway router at priority `100000` and a backend deny route
   at priority `90000`, so a gateway outage returns `404` instead of silently
   falling back to the runtime while the backend is healthy. The ERP keeps
   using the same `libsql://<database-host>` URL.

   If your Coolify deployment only accepts one compose file, copy the
   `libsqlite-gateway-root` and `libsqlite-gateway-deny` labels into the main
   compose file and replace `${DATABASE_GATEWAY_ROOT_HOST}` with the literal
   database host. Do not leave literal `${...}` text in a Traefik label.

The original direct runtime route still exists at lower priority as a last
resort; complete removal requires internalizing the runtime. See
[POLICY_GATEWAY.md](docs/POLICY_GATEWAY.md) for the complete rollout.

## 9. Recommended production flow

1. Deploy backend in Coolify.
2. Attach a persistent volume.
3. Configure `MASTER_KEY` and the storage/discovery env vars.
4. Create a project in the panel.
5. Create a new SQLite database or import/adopt existing `.db` files.
6. Register libsql remote databases with URL + token.
7. Run migrations from your code or CI pipeline.
8. Copy the public URL and token from the database detail page and use them in your ERP or editor env vars.

Example app env:

```env
DATABASE_URL=https://mi-db.db.example.com
DATABASE_AUTH_TOKEN=xxxxx
```

## 10. What Coolify gives you here

- Docker deployment with restart policies.
- Environment variable management.
- Persistent storage.
- Reverse proxy and TLS.
- Optional wildcard subdomain routing.

## 11. Important limitation

The backend can only manage databases it can access or that you explicitly register/import.
It does not safely scan arbitrary remote machines for credentials or database locations.

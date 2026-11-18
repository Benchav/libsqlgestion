# Connect an ERP using `@libsql/client` embedded replicas

This guide is for an external backend (for example an ERP) that uses `@libsql/client` with a local embedded replica:

```env
TURSO_DATABASE_URL=file:/persistent/erp.db
TURSO_AUTH_TOKEN=<token>
TURSO_SYNC_URL=libsql://<database-host>
TURSO_SYNC_INTERVAL=60
```

That setup needs a real libSQL server for `TURSO_SYNC_URL`. A `LOCAL-FILE` database only exposes the backend HTTP pipeline; it does not implement the replication protocol used by embedded replicas.

LibSQLite supports two kinds of real primary:

1. a dedicated `libsql-server` runtime, normally published as `libsql://erp-db.example.com`;
2. a shared `sqld` namespace, published as `libsql://erp-db.example.com` (the first DNS label must match the namespace).

Both work with embedded replicas. Use the dedicated runtime when you want one container per database; use the shared namespace when you already run the `sqld` service from `docker-compose.yml`.

> **Important:** embedded replica sync selects the namespace from the host header
> (first DNS label) or the `x-namespace` header, not from the `/dev/<namespace>/`
> URL path. A path-based URL such as `https://panel.example.com/dev/erp-db/`
> works for HTTP pipeline clients but **cannot** be used as `TURSO_SYNC_URL`.

## Recommended topology

For one ERP database, use a dedicated `libsql-server` runtime with a fixed subdomain:

```text
Panel:       https://data.example.com
Database:    libsql://erp-db.example.com
Replica:     file:/persistent/erp.db
```

Cloudflare Universal SSL does not cover a two-level DB host such as
`erp-db.data.example.com`. For that shape, let Traefik issue a per-host
certificate with the DNS record set to DNS-only, or use an advanced/wildcard
certificate. The shared-namespace section below uses the per-host Traefik route.

## 1. LibSQLite configuration

Set the backend environment:

```env
DATABASE_PUBLIC_DOMAIN=example.com
DATABASE_PUBLIC_PROTOCOL=https
LIBSQL_REQUIRE_PRIMARY=true
LIBSQL_ALLOW_LOCAL_FILE=false
LIBSQL_PRIMARY_MODE=runtime
LIBSQL_RUNTIME_TOKEN_TTL_SECONDS=31536000
# Docker network shared with the backend and Traefik
LIBSQL_RUNTIME_NETWORK=coolify
SQLD_PUBLIC_DOMAIN=

# TLS labels applied to dynamically created dedicated runtimes.
# Use the resolver name configured in your Traefik/Coolify instance.
TRAEFIK_CERT_RESOLVER=letsencrypt
TRAEFIK_ENTRYPOINT=websecure
```

- `DATABASE_PUBLIC_DOMAIN` is the parent used for the runtime URL (`erp-db.example.com`).
- Keep `SQLD_PUBLIC_DOMAIN` empty when using per-database runtimes so the namespace wildcard does not capture other app subdomains.
- `LIBSQL_PRIMARY_MODE=runtime` makes new databases and imports provision a dedicated `libsql-server`.
- `LIBSQL_RUNTIME_NETWORK` must be the network shared by the backend and Traefik (usually `coolify`). Without it, the runtime cannot be reached by container name or routed publicly; the backend now fails provisioning instead of creating it on the default `bridge` network.
- `LIBSQL_PROVISION_ASYNC=false` makes the import wait for the container and return the real runtime JWT. If you keep it `true`, use **Rotate Token** after the database becomes active.

Import the ERP database with a fixed subdomain, for example:

```text
erp-db
```

Wait until the panel shows:

```text
Runtime: DOCKER-LIBSQL
Public URL: libsql://erp-db.example.com
```

Then rotate the token if needed and copy the JWT. The JWT is the value for `TURSO_AUTH_TOKEN`.

If the panel shows `<subdomain>.localhost`, the **Wildcard domain** is empty.
The **Base URL** is only for `LOCAL-FILE` databases. Set the Wildcard domain,
ensure `TRAEFIK_CERT_RESOLVER` is configured, redeploy the backend, and rotate
the token so the runtime container is recreated with the new host/TLS labels.

## 2. DNS and TLS

Expose the fixed hostname through Cloudflare Tunnel or your Traefik/DNS setup:

```text
erp-db.example.com -> Traefik port 80
```

The runtime container listens on port `8080`. Cloudflare Tunnel and Traefik both support the WebSocket/HTTP upgrade used by libSQL replication.

## 3. ERP environment

Keep the local embedded replica and point it to the self-hosted server:

```env
TURSO_DATABASE_URL=file:/persistent/erp.db
TURSO_SYNC_URL=libsql://erp-db.example.com
TURSO_AUTH_TOKEN=<JWT from LibSQLite>
TURSO_SYNC_INTERVAL=60
```

Important:

- Do not reuse the Turso token. The self-hosted server validates JWTs signed by LibSQLite's auth key.
- Check that `DATABASE_URL` and `DATABASE_AUTH_TOKEN` are not set to old values. They take precedence over `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in the ERP configuration.
- Keep the local file path unchanged if you want to retain the embedded replica.

Remote-only alternative:

```env
TURSO_DATABASE_URL=libsql://erp-db.example.com
TURSO_AUTH_TOKEN=<JWT>
# remove TURSO_SYNC_URL and TURSO_SYNC_INTERVAL
```

Remote-only is simpler, but it loses the local replica and the ERP's degraded-local-read mode.

## Shared `sqld` namespace (host-based alternative)

If you deploy the whole project with the included `docker-compose.yml`, the
`sqld` service is already a real primary. You can publish a namespace on its own
host:

```text
Panel:      https://data.example.com
Database:   libsql://erp-db.data.example.com
Replica:    file:/persistent/erp.db
```

The **first DNS label must match the namespace** (`erp-db`). This is how the
libSQL replication client selects the namespace; the `/dev/<namespace>/` path is
only used by HTTP pipeline clients.

Backend environment (all future databases as shared namespaces):

```env
LIBSQL_REQUIRE_PRIMARY=true
LIBSQL_ALLOW_LOCAL_FILE=false
LIBSQL_PRIMARY_MODE=namespace
LIBSQL_CONVERSION_MODE=namespace
LIBSQL_NAMESPACE_PUBLIC_ENABLED=true

DATABASE_PUBLIC_DOMAIN=data.example.com
DATABASE_PUBLIC_PROTOCOL=https
SQLD_PUBLIC_DOMAIN=data.example.com
```

Compose/Traefik environment for the wildcard:

```env
# Must be a DNS-01 resolver able to issue *.data.example.com.
TRAEFIK_WILDCARD_CERT_RESOLVER=<dns01-resolver>
TRAEFIK_ENTRYPOINT=websecure
```

Use the optional wildcard override:

```bash
docker compose -f docker-compose.yml -f docker-compose.wildcard.yml up -d
```

It adds TLS and wildcard domains to the `sqld` router, so all namespace hosts
such as `erp-db.data.example.com` are served by the shared `sqld`.

For a **single namespace host**, you can skip the wildcard override and use the
exact router instead:

```env
LIBSQL_NAMESPACE_HOST=erp-db.data.example.com
LIBSQL_NAMESPACE_PUBLIC_ENABLED=true
TRAEFIK_CERT_RESOLVER=letsencrypt
```

If you use a **dedicated runtime** instead, leave `LIBSQL_NAMESPACE_HOST` empty
and leave `SQLD_PUBLIC_DOMAIN` empty so the shared `sqld` routers do not capture
the runtime hostname.

After converting/importing the database, use the namespace URL in the ERP:

```env
TURSO_DATABASE_URL=file:/persistent/erp.db
TURSO_SYNC_URL=libsql://erp-db.data.example.com
TURSO_AUTH_TOKEN=<JWT from the panel>
TURSO_SYNC_INTERVAL=60
```

Validate it with the embedded test before switching production:

```bash
cd backend
npm run test:external -- libsql://erp-db.data.example.com "<JWT>" --embedded
```

If the shared-namespace host is not suitable, use the dedicated runtime
topology above instead.

## Migrating legacy LOCAL-FILE databases

`LOCAL-FILE` is legacy-only. New databases/imports must be libSQL primaries.
To migrate existing local files:

```bash
cd backend

# Inspect first. Default mode is runtime and no changes are made.
npm run migrate:local-to-primary -- --mode=runtime --dry-run

# Execute.
npm run migrate:local-to-primary -- --mode=runtime --apply

# Or, after wildcard namespace public routing is configured:
npm run migrate:local-to-primary -- --mode=namespace --apply
```

The script:

- skips databases that are already libSQL primaries;
- copies each local file with `VACUUM INTO`;
- keeps the original local file at `previousLocalPath`;
- prints the new sync URL and JWT for each database;
- continues after individual failures and exits non-zero if any failed.

Decide the target before running: runtime and namespace are both valid libSQL
primaries, but runtime → namespace conversion is not implemented in this
version. If wildcard namespace routing is ready, migrate directly with
`--mode=namespace`; otherwise use `--mode=runtime` and keep those databases as
dedicated primaries.

Stop writes to each database during the migration. Take a full backup of
`/app/data`, the `sqld` volume and the ERP replica first.

## 4. Migrate data before switching

The new `libsql-server` starts empty. Do not point the ERP at it until it contains the current data.

1. Back up:
   - the ERP local replica (`/persistent/erp.db`),
   - the current Turso database,
   - the LibSQLite volumes.
2. Confirm which database is the source of truth. The panel database name and the Turso database name may not be the same.
3. Create a consistent snapshot of the ERP data. Use the ERP backup script or `VACUUM INTO`; do not copy only the main `.db` file while WAL writes are active.
4. Import that snapshot into the runtime database in LibSQLite.
5. Verify row counts and recent records for sales, products, stock, customers, cash and credits.
6. Stop the ERP writes before the final switch.
7. Back up and move the old local replica aside so it can be recreated from the new primary:

   ```text
   /persistent/erp.db -> /persistent/erp.db.backup
   ```

8. Start the ERP with the new `TURSO_SYNC_URL` and JWT. It will create a fresh local replica from the self-hosted primary.

If the new primary does not contain all data, do not switch. Restore the old environment and repeat the import.

## 5. Validate

From a machine that can reach the database host:

```bash
cd backend
npm run test:external -- libsql://erp-db.example.com "<JWT>"
npm run test:external -- libsql://erp-db.example.com "<JWT>" --embedded
```

The first command tests a remote client. The second tests the embedded replica pattern used by the ERP.

Then verify in the ERP:

- startup logs show the embedded replica and the self-hosted sync URL;
- a read works;
- a write works and is visible in LibSQLite Studio;
- a sync cycle completes without stream errors.

## 6. Rollback

Keep the old values available:

```env
TURSO_SYNC_URL=libsql://<old-turso-host>
TURSO_AUTH_TOKEN=<old-turso-token>
```

If the self-hosted primary or the runtime container fails, restore the old sync URL/token and restart the ERP. Keep the local replica backup until the new setup has been stable for several days.

## 7. Token expiry

Runtime tokens expire. The default is one year for `libsql-server` runtimes, and the value can be changed with `LIBSQL_RUNTIME_TOKEN_TTL_SECONDS`. Rotating a runtime token recreates the container and invalidates the old token, so update the ERP environment after rotating.

## 8. Production

Do not point a production ERP at a Testing LibSQLite instance. Use a separate production/dedicated deployment with its own persistent volume, domain and backups.

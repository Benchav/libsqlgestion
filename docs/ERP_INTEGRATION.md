# Connect an ERP using `@libsql/client` embedded replicas

This guide is for an external backend (for example an ERP) that uses `@libsql/client` with a local embedded replica:

```env
TURSO_DATABASE_URL=file:/persistent/erp.db
TURSO_AUTH_TOKEN=<token>
TURSO_SYNC_URL=libsql://<database-host>
TURSO_SYNC_INTERVAL=60
```

That setup needs a real libSQL server for `TURSO_SYNC_URL`. A `LOCAL-FILE` database only exposes the backend HTTP pipeline; it does not implement the replication protocol used by embedded replicas.

## Recommended topology

For one ERP database, use a dedicated `libsql-server` runtime with a fixed subdomain:

```text
Panel:       https://data.example.com
Database:    libsql://erp-db.example.com
Replica:     file:/persistent/erp.db
```

Do not use a two-level DB host such as `erp-db.data.example.com` on Cloudflare Free; the normal certificate only covers one wildcard level under the root domain.

## 1. LibSQLite configuration

Set the backend environment:

```env
DATABASE_PUBLIC_DOMAIN=example.com
DATABASE_PUBLIC_PROTOCOL=https
LIBSQL_NAMESPACE_IMPORTS=false
LIBSQL_IMPORT_RUNTIME=true
LIBSQL_RUNTIME_TOKEN_TTL_SECONDS=31536000
SQLD_PUBLIC_DOMAIN=
```

- `DATABASE_PUBLIC_DOMAIN` is the parent used for the runtime URL (`erp-db.example.com`).
- Keep `SQLD_PUBLIC_DOMAIN` empty when using per-database runtimes so the namespace wildcard does not capture other app subdomains.
- `LIBSQL_IMPORT_RUNTIME=true` makes imports provision a dedicated `libsql-server`.
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

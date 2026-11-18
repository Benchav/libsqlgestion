# Troubleshooting

## The backend does not start

Check:

- `MASTER_KEY` exists and has 64 hex characters
- the data directory is writable
- the control database file path is correct

## SQLite discovery finds nothing

Check:

- `SQLITE_DISCOVERY_PATH` points to a mounted directory
- the directory contains files ending in `.db`
- the configured project ID exists

Discovery intentionally ignores `projects/` and `snapshots/` directories so it
does not register managed databases or restore points as new databases.

## Imported databases are not updated

Remember:

- import copies the `.db` file into managed storage
- changes should be made through queries or migrations against the managed copy

## Public URL still points to localhost

For `LOCAL-FILE` databases the panel builds the public URL from `DATABASE_PUBLIC_BASE_URL`, or from the **Base URL** field in `Settings -> Public Database Routing`.

Set it to the public HTTPS base URL of the backend, for example:

```env
DATABASE_PUBLIC_BASE_URL=https://libsql.example.com
DATABASE_PUBLIC_PROTOCOL=https
```

The generated URL must look like:

```text
https://libsql.example.com/api/v1/databases/<id>/
```

The wildcard domain setting is only used by `sqld` namespaces, not by `LOCAL-FILE` databases.

## Runtime URL shows `<name>.localhost` or Backend health fails

For a dedicated runtime or a shared namespace, the **Wildcard domain** setting
builds the public URL. The **Base URL** setting is only for `LOCAL-FILE`
databases. If the Wildcard domain is empty, the panel falls back to
`https://<subdomain>.localhost`.

Fix:

1. Set **Wildcard domain** to the parent domain, for example `data.example.com`.
2. Set `TRAEFIK_CERT_RESOLVER` to the resolver used by your Traefik instance.
3. Redeploy/restart the backend so it reads the new environment.
4. Rotate the runtime token. This recreates the container with the new
   `Host(...)` and TLS labels. Changing only the panel setting does not update
   an existing container's Docker labels.

The runtime's internal URL is `http://container:8080`; the published host port is
also HTTP. Only the canonical public URL is HTTPS, terminated by Traefik. Older
builds used `https://host.docker.internal:<port>` for the Backend check; current
builds use `http://`. If you still see the HTTPS host-port URL, redeploy the
updated backend and rotate the runtime token.

## Embedded replica fails with `Invalid header bit 123 expected 0 or 1`

This error comes from the libSQL replication client, not from SQLite or the token.
The first byte of the response is `{` (ASCII 123), because the sync request hit a
JSON endpoint instead of a binary libSQL replication stream.

The usual cause is using a `LOCAL-FILE` URL as `TURSO_SYNC_URL`:

```env
# Wrong: this is the HTTP pipeline shim, not a libSQL primary
TURSO_SYNC_URL=https://panel.example.com/api/v1/databases/<id>/
```

Use a real primary instead:

```env
# Dedicated runtime
TURSO_SYNC_URL=libsql://erp-db.example.com

# Shared sqld namespace (first label must match the namespace)
TURSO_SYNC_URL=libsql://erp-db.example.com
```

The `/dev/<namespace>/` path is only valid for HTTP pipeline clients. Embedded
replica sync selects the namespace from the host header or `x-namespace`, not
from the URL path.

Validate before switching the ERP:

```bash
cd backend
npm run test:external -- libsql://erp-db.example.com "<JWT>" --embedded
```

The host's first DNS label must equal the namespace. For example, namespace
`erp-db` must be used as `libsql://erp-db.data.example.com`, never as
`libsql://data.example.com/dev/erp-db/`. A mismatch usually surfaces as
`NamespaceDoesntExist` during the replication handshake.

If the namespace host shows `TRAEFIK DEFAULT CERT`, Traefik has not issued a
certificate for that hostname. Set `LIBSQL_NAMESPACE_HOST` to the exact host and
`TRAEFIK_CERT_RESOLVER` to the resolver used by your Traefik (usually
`letsencrypt`), then redeploy the compose stack. For multiple namespaces, use a
wildcard certificate or one exact router per host.

## Imports fail with `fetch failed: getaddrinfo EAI_AGAIN sqld`

This means the backend tried to reach the `sqld` namespace service but Docker DNS could not resolve the hostname `sqld`.

Check:

- the `sqld` container is running
- `sqld` and `backend` share the same Docker network
- `LIBSQL_ADMIN_URL` and `LIBSQL_INTERNAL_URL` point to the hostname that is reachable from the backend
- the backend and `sqld` share the same `/var/lib/sqld` data volume
- `auth.pem` exists in that volume before `sqld` starts

From the backend container:

```bash
node -e "require('dns').lookup('sqld',(e,a)=>console.log(e?e.code:a))"
wget -qO- http://sqld:9090/health
```

If `sqld` is not part of the deployment, disable namespace imports:

```env
LIBSQL_ENABLE_NAMESPACES=false
LIBSQL_ADMIN_URL=
LIBSQL_NAMESPACE_IMPORTS=false
```

The Compose stack defaults `LIBSQL_NAMESPACE_IMPORTS` to `false`, so imports are stored locally. With `auto`, an import falls back to a local SQLite file when `sqld` is unreachable instead of silently registering a broken database.

If a database was already registered as a namespace database and `sqld` is still unavailable, repair it from the API:

```bash
curl -X POST http://localhost:5000/api/v1/databases/<databaseId>/convert-to-local \
  -H "Authorization: Bearer <accessToken>" \
  -H "x-csrf-token-v2: <csrfToken>"
```

The endpoint copies the namespace file into managed local storage, updates the record to a normal SQLite database, and evicts the old pooled connection.

## Snapshots are not being created

Check:

- `SNAPSHOTS_ENABLED=true` in the backend environment
- the database is `LOCAL-FILE`; remote and `sqld` runtime databases are skipped in this version
- the backend has free disk space above `SNAPSHOT_MIN_FREE_BYTES`
- the backend logs contain `[snapshots]` messages
- `/app/data/sqlite/snapshots` is inside the persistent volume

The scheduler wakes every `SNAPSHOT_SCHEDULER_TICK_MINUTES` (default 5) and uses
each database's backup policy. The default restore-point interval is
`SNAPSHOT_INTERVAL_MINUTES` (60), editable from the database detail page. They
are restore points, not continuous WAL recovery; the RPO equals the configured
restore-point interval.

## Restore fails

Check:

- the snapshot status is `ready`
- the snapshot file exists under `SQLITE_STORAGE_ROOT/snapshots`
- `SNAPSHOT_VERIFY_ON_RESTORE=true` did not detect a checksum mismatch
- the backend can write to `SQLITE_STORAGE_ROOT/projects`

Restoring always creates a new database. The original database is not modified.

## libsql connection fails

Check:

- URL is correct
- token is valid
- remote server is reachable from your deployment environment

## Coolify deployment fails

Check:

- the Dockerfile path is correct
- the exposed port is `3000`
- `/app/data` is mounted as persistent storage
- `MASTER_KEY` is set

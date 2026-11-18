# Troubleshooting

## The backend does not start

Check:

- `MASTER_KEY` exists and has 64 hex characters
- the data directory is writable
- the control database file path is correct

## `Failed to execute 'removeChild' on 'Node'` / "Something went wrong"

This is a browser DOM error, usually caused by **automatic page translation**
(Chrome/Edge/Google Translate) or an extension that rewrites the DOM. The
translator moves or wraps React's text nodes, and React later tries to remove a
node that is no longer its direct child.

The control plane now sets:

```html
<html lang="en" translate="no" class="notranslate">
<meta name="google" content="notranslate">
```

If the error still appears:

1. Open the panel in an incognito window with extensions disabled.
2. Disable automatic translation for the panel hostname, then reload.
3. If it still happens, check for invalid HTML nesting or a DOM-injecting
   extension.

Automatic translation is not a substitute for localization. If the UI must be
in Spanish, implement a real i18n layer instead of relying on the browser.

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

The wildcard domain setting is used by runtime and namespace URLs, not by `LOCAL-FILE` databases.

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

## Runtime health shows `Internal: Fail` or `Public: Fail`

`Backend: OK` means the runtime is alive and the published host port works.
`Internal: Fail` means the backend cannot resolve
`http://libsqlite-<id>:8080`, and `Public: Fail` means Traefik cannot reach the
container. Both usually mean the runtime was created on the default `bridge`
network instead of the shared backend/Traefik network.

Check:

```bash
docker inspect <runtime-container> --format '{{json .NetworkSettings.Networks}}'
docker inspect <backend-container> --format '{{json .NetworkSettings.Networks}}'
docker inspect coolify-proxy --format '{{json .NetworkSettings.Networks}}'
```

The runtime must share a network with both the backend and `coolify-proxy`.

Fix:

1. Set `LIBSQL_RUNTIME_NETWORK` to that network (usually `coolify`). Leave it
   empty only if automatic detection works; the backend prefers a network
   shared with the proxy and refuses to create runtimes on `bridge`.
2. Redeploy the backend so the new code and variable are active.
3. Rotate the runtime with **Create new token**. Existing containers keep their
   old network and labels until they are recreated.
4. Re-check `https://<subdomain>.<wildcard-domain>` and rerun the embedded
   replica test.

If you do not want to rotate yet, you can attach the existing container
manually, but Traefik labels still point at the old network until it is
recreated:

```bash
docker network connect coolify <runtime-container>
```

## `Public: Fail` with a public DNS NXDOMAIN or a Coolify 503 page

There are two different public failures:

- **NXDOMAIN**: the public hostname does not exist. External clients cannot
  resolve it. The local resolver can return a cached or captive answer, so
  verify with Cloudflare DoH:

  ```bash
  curl -H "Accept: application/dns-json" \
    "https://cloudflare-dns.com/dns-query?name=<host>&type=A"
  ```

  `Status: 3` means NXDOMAIN.

- **503 "Site not available" from Coolify**: DNS works, but Traefik has no
  healthy route for that Host. Check labels and networks.

A wildcard on the parent does not cover a deeper name. For example:

```text
*.ibarrera.site        covers  foo.ibarrera.site
*.ibarrera.site   NOT  covers  foo.data.ibarrera.site
```

If the panel's **Wildcard domain** is `data.ibarrera.site`, you need a record
for:

```text
*.data.ibarrera.site
```

Create it in Cloudflare:

- **Through the existing Tunnel:** add a public hostname
  `*.data.ibarrera.site` in Zero Trust → Networks → Tunnels → your tunnel,
  pointing to the same Coolify proxy service.
- **Direct to the origin:** create a DNS-only A record for
  `*.data.ibarrera.site` pointing to the server IP, then configure a wildcard
  certificate in Traefik with DNS-01.

Use **Settings → Public Database Routing → Test wildcard DNS** to verify the
record before importing.

## New create/import is blocked: no libSQL primary available

The libSQL-first policy refuses to create a new `LOCAL-FILE` database when:

```env
LIBSQL_REQUIRE_PRIMARY=true
LIBSQL_ALLOW_LOCAL_FILE=false
```

Check the storage capabilities from the panel. You need either:

- the Docker socket available for a dedicated runtime;
- `sqld` reachable and `LIBSQL_NAMESPACE_PUBLIC_ENABLED=true` for a shared namespace.

If you intentionally want a legacy local file, set `LIBSQL_ALLOW_LOCAL_FILE=true`
(and likely `LIBSQL_REQUIRE_PRIMARY=false`). Existing `LOCAL-FILE` databases are
not affected by the policy.

## Shared namespace says public routing is not enabled

Set:

```env
LIBSQL_NAMESPACE_PUBLIC_ENABLED=true
DATABASE_PUBLIC_DOMAIN=data.example.com
SQLD_PUBLIC_DOMAIN=data.example.com
```

For multiple namespaces, deploy the wildcard override:

```bash
docker compose -f docker-compose.yml -f docker-compose.wildcard.yml up -d
```

with a DNS-01 resolver in `TRAEFIK_WILDCARD_CERT_RESOLVER`. For a single host,
set `LIBSQL_NAMESPACE_HOST` to that exact host and use the exact router.

Set `LIBSQL_NAMESPACE_PUBLIC_ENABLED` in the Coolify/compose environment, not
only in `backend/.env`: the compose `environment` block overrides `env_file`.
The same applies to `SQLD_PUBLIC_DOMAIN` and `LIBSQL_RUNTIME_NETWORK`.

If you use only `LIBSQL_NAMESPACE_HOST`, the import subdomain must match its
first DNS label. Wildcard routing (`LIBSQL_NAMESPACE_PUBLIC_ENABLED=true`) is
what allows arbitrary namespace names.

## Import stays on "Importing" or takes a long time

The import response waits only for the primary to accept connections; public
DNS/TLS health is now checked in the background. If an import is still slow:

1. Prefer **Server path** when the `.db` is already on the server. Uploading a
   large file depends on the client's connection.
2. The panel gzip-compresses the file in the browser before uploading when
   `CompressionStream` is supported. A 100 MB SQLite file often uploads as
   20–40 MB. The **Compressed** line shows the actual reduction.
3. Use **Cancel upload** while the progress bar is moving if you need to stop
   and retry through **Server path**.
4. Check `MAX_UPLOAD_SIZE_BYTES` (default 500 MB). A reverse proxy or Cloudflare
   may impose a lower limit; Cloudflare's default request-body limit is 100 MB.
   Browser compression usually brings a 100–150 MB SQLite file below that limit.
   For larger files, use **Server path**.
3. Look at the backend log lines:
   ```text
   [DatabaseService] imported <id> (...) as runtime in ...ms (copy ..., primary ...)
   [LibsqlRuntimeService] provisioned <id> in ...ms
   ```
   They show whether time is spent in the upload, the file copy or the container.
4. If the import fails, check Audit for `database.provision_failed`. The real
   Docker/libSQL error is stored there.
5. Confirm the runtime is on the shared Docker network and that
   `LIBSQL_RUNTIME_NETWORK=coolify` is set. A runtime on `bridge` cannot be
   reached by container name.

Uploaded files are copied directly; server-side paths use `VACUUM INTO` to
capture a consistent snapshot from a live database. For a namespace import,
`storageMode=namespace` is much faster because it does not create a container.

## Runtime health stays stale after fixing DNS/TLS

Use **Re-check** in the database detail page. It calls
`POST /databases/:id/health-check` and updates the stored route health without
rotating the token. The background check runs a few times after provisioning.

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
certificate for that hostname. For a single host, set `LIBSQL_NAMESPACE_HOST` and
`LIBSQL_NAMESPACE_PUBLIC_ENABLED=true`, then redeploy. For multiple namespaces,
use `docker-compose.wildcard.yml` with a DNS-01 wildcard resolver in
`TRAEFIK_WILDCARD_CERT_RESOLVER` and set `LIBSQL_NAMESPACE_PUBLIC_ENABLED=true`.

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

If `sqld` is not part of the deployment, disable namespaces and rely on the
dedicated runtime:

```env
LIBSQL_ENABLE_NAMESPACES=false
LIBSQL_ADMIN_URL=
LIBSQL_NAMESPACE_PUBLIC_ENABLED=false
```

With the libSQL-first policy (`LIBSQL_REQUIRE_PRIMARY=true`,
`LIBSQL_ALLOW_LOCAL_FILE=false`), create/import requests fail with a clear 503
instead of silently falling back to a local file. The legacy
`LIBSQL_NAMESPACE_IMPORTS` fallback only applies when `LIBSQL_REQUIRE_PRIMARY=false`.

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

After migrating to libSQL primaries, the local-file snapshot scheduler no longer
applies to those databases. Back up the runtime volume and the `sqld` data volume
instead. The old LOCAL-FILE snapshots remain valid as pre-migration backups.

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

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

## Imported databases are not updated

Remember:

- import copies the `.db` file into managed storage
- changes should be made through queries or migrations against the managed copy

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

With `LIBSQL_NAMESPACE_IMPORTS=auto` (the default), an import falls back to a local SQLite file when `sqld` is unreachable instead of silently registering a broken database.

If a database was already registered as a namespace database and `sqld` is still unavailable, repair it from the API:

```bash
curl -X POST http://localhost:5000/api/v1/databases/<databaseId>/convert-to-local \
  -H "Authorization: Bearer <accessToken>" \
  -H "x-csrf-token-v2: <csrfToken>"
```

The endpoint copies the namespace file into managed local storage, updates the record to a normal SQLite database, and evicts the old pooled connection.

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

# Production Guide

This guide is the recommended path to deploy libsqlite in production on Ubuntu, VPS, or Coolify.

It assumes:

- you have a domain or subdomain ready
- you can mount a persistent volume
- you want the backend and frontend to be deployable as separate Docker apps

## 1. Production architecture

Recommended split:

- `backend`: API, authentication, RBAC, control plane, migrations, discovery, SQLite/libsql operations
- `frontend`: admin panel UI

Recommended storage split:

- control plane DB: `control.db`
- managed SQLite databases: structured tree under `SQLITE_STORAGE_ROOT`
- optional raw discovery path: mounted folder with existing `.db` files before adoption

Recommended routing:

- `panel.tudominio.com` -> frontend
- `api.tudominio.com` -> backend
- optional `*.tudominio.com` -> per-database hostnames if you later wire wildcard routing

## 2. Backend deployment in Coolify

Create a new Docker app for the backend.

Suggested settings:

- build context: `backend/`
- Dockerfile: `backend/Dockerfile`
- exposed port: `3000`
- health check: `/health`

### Backend environment variables

Use values like these:

```env
MASTER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
DATABASE_FILE=/app/data/control.db
PORT=3000
CORS_ORIGIN=https://panel.tudominio.com
SQLITE_STORAGE_ROOT=/app/data/sqlite
SQLITE_DISCOVERY_PATH=/app/data/sqlite-discovery
SQLITE_DISCOVERY_PROJECT_ID=<project-id>
SQLITE_DISCOVERY_ADOPT=true
```

Notes:

- `MASTER_KEY` must be 64 hex characters.
- `SQLITE_STORAGE_ROOT` is where managed SQLite files are written.
- `SQLITE_DISCOVERY_PATH` should point to a mounted directory with existing `.db` files.
- `SQLITE_DISCOVERY_ADOPT=true` makes the backend copy discovered files into managed storage.

### Backend volumes

Mount:

- `/app/data`

Recommended host layout:

```text
/srv/libsqlite/backend-data/
  control.db
  sqlite/
    projects/
      <projectId>/
        databases/
          <databaseId>.db
  sqlite-discovery/
    legacy-app.db
```

## 3. Frontend deployment in Coolify

Create a second Docker app for the frontend.

Suggested settings:

- build context: `frontend/`
- Dockerfile: `frontend/Dockerfile`
- exposed port: `3000`

### Frontend environment variables

```env
NEXT_PUBLIC_API_URL=https://api.tudominio.com/api/v1
```

The frontend only needs the public API URL.

## 4. DNS and TLS

Set DNS records:

- `api.tudominio.com` -> backend service
- `panel.tudominio.com` -> frontend service

If you want wildcard hostnames later:

- `*.tudominio.com` -> reverse proxy or Coolify wildcard routing

## 5. First production bootstrap

### Step 1: deploy backend

1. Create the backend app.
2. Set environment variables.
3. Mount persistent storage.
4. Deploy.
5. Verify:

```text
GET https://api.tudominio.com/health
GET https://api.tudominio.com/ready
```

### Step 2: create the first admin user

Use the backend auth endpoint:

```bash
curl -X POST https://api.tudominio.com/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@tudominio.com","password":"StrongPassword123!"}'
```

### Step 3: deploy frontend

1. Create the frontend app.
2. Set `NEXT_PUBLIC_API_URL`.
3. Deploy.
4. Open `https://panel.tudominio.com`.

## 6. Working with existing SQLite files

If you already have `.db` files on the server:

### Option A: discover first

1. Mount the discovery directory.
2. Set `SQLITE_DISCOVERY_PATH`.
3. Keep `SQLITE_DISCOVERY_ADOPT=false`.
4. Scan the directory.

### Option B: adopt directly

1. Mount the directory.
2. Set `SQLITE_DISCOVERY_ADOPT=true`.
3. Let the backend adopt the files into managed storage.

## 7. Creating new databases in production

Typical flow:

1. Create a project.
2. Create a new SQLite database.
3. Save the generated database metadata.
4. Use the returned file and subdomain identifier.
5. Apply migrations from your code or CI.

## 8. Importing databases from another server

If you have a file from another app or environment:

1. Place the file in a readable path inside the backend container or VM.
2. Call the import endpoint.
3. The backend copies the file into managed storage.
4. Apply migrations or queries as needed.

## 9. libsql remote databases

For remote libsql:

1. Register the URL and token.
2. Test the connection.
3. Use the schema and query endpoints.
4. Run migrations through the API.

## 10. Backups

Backup these items separately:

- `control.db`
- managed SQLite files under `SQLITE_STORAGE_ROOT`
- any raw discovery folder if you still keep one

Suggested backup cadence:

- control plane: daily
- managed databases: according to business criticality
- offsite copy: at least one additional location

## 11. Restore sequence

1. Restore the control plane database.
2. Restore the managed SQLite tree.
3. Verify file permissions.
4. Verify `/health` and `/ready`.
5. Log in and inspect projects/databases.

## 12. Operational checks

Before accepting traffic:

- backend responds to `/health`
- backend responds to `/ready`
- frontend can reach `NEXT_PUBLIC_API_URL`
- audit log writes succeed
- storage volume is persistent
- `MASTER_KEY` is correct

## 13. Common production mistakes

- forgetting to mount `/app/data`
- pointing `NEXT_PUBLIC_API_URL` at localhost in production
- using the wrong `MASTER_KEY` across restarts
- enabling discovery without mounting the discovery path
- expecting the backend to scan arbitrary remote hosts automatically

## 14. Recommended final production posture

- keep backend and frontend as separate services
- keep the control plane DB private
- keep managed SQLite files on persistent storage
- use migrations from code, not manual edits
- rotate tokens when users or environments change
- keep audit logs enabled

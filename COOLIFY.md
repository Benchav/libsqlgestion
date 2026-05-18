# Coolify Deployment Guide

This project is designed to run as a Docker app in Coolify. The backend manages SQLite files and libsql connections, and it can also discover or adopt `.db` files mounted from the server.

For the full end-to-end setup, including Cloudflare DNS, wildcard subdomains, and API integration examples, see [docs/PUBLIC_DATABASES.md](docs/PUBLIC_DATABASES.md).
The panel also manages public database routing directly, so the Coolify env vars act as bootstrap defaults and fallback values.

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

## 8. Recommended production flow

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

## 9. What Coolify gives you here

- Docker deployment with restart policies.
- Environment variable management.
- Persistent storage.
- Reverse proxy and TLS.
- Optional wildcard subdomain routing.

## 10. Important limitation

The backend can only manage databases it can access or that you explicitly register/import.
It does not safely scan arbitrary remote machines for credentials or database locations.

# Coolify Deployment Guide

This project is designed to run as a Docker app in Coolify. The backend manages SQLite files and libsql connections, and it can also discover or adopt `.db` files mounted from the server.

## 1. Recommended topology

- `backend` service: API + control plane.
- Optional `frontend` service later: admin panel.
- Persistent volume for SQLite control data and managed database files.
- Wildcard subdomain through your reverse proxy or Coolify routing.

## 2. Coolify service setup

Create a new Docker application in Coolify using the backend repository.

Use these settings:

- Build context: repository root or `backend/` depending on how you wire the app in Coolify.
- Dockerfile: `backend/Dockerfile`
- Exposed port: `3000`
- Health check path: `/health`

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
```

Notes:

- `MASTER_KEY` must be 64 hex characters.
- `SQLITE_STORAGE_ROOT` is where managed SQLite files are written.
- `SQLITE_DISCOVERY_PATH` is the directory the backend scans for existing `.db` files.
- `SQLITE_DISCOVERY_ADOPT=true` copies discovered databases into the managed storage tree so everything stays unified.

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

The database subdomain is metadata in the control plane; routing is handled by Coolify or your proxy layer.

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

## 9. What Coolify gives you here

- Docker deployment with restart policies.
- Environment variable management.
- Persistent storage.
- Reverse proxy and TLS.
- Optional wildcard subdomain routing.

## 10. Important limitation

The backend can only manage databases it can access or that you explicitly register/import.
It does not safely scan arbitrary remote machines for credentials or database locations.

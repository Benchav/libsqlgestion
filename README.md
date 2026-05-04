# libsqlite

Self-hosted database management platform for SQLite and libsql.

The goal of this project is to provide a Turso-like experience on your own infrastructure:

- manage multiple SQLite databases from a web panel
- register and manage libsql remote databases
- import existing `.db` files
- discover SQLite files mounted from your server
- run migrations from code or CI without using the panel
- deploy cleanly on local servers, VPS, and Coolify

## Current status

The backend is implemented and validated. It includes:

- authentication and RBAC
- project and database management
- encrypted token storage
- SQLite file provisioning and import
- discovery/adoption of mounted `.db` files
- libsql remote connectivity
- schema browsing and query execution
- per-database migration history
- audit logging
- health and readiness endpoints
- Docker and Coolify deployment support

 The frontend admin panel is scaffolded in `frontend/` and now includes a working dashboard, projects, databases, database detail, studio, login, and settings views.

 Session cookies are `HttpOnly` and the backend uses them for the default browser flow.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Usage Guide](docs/USAGE.md)
- [Operations Manual](docs/OPERATIONS.md)
- [Production Guide](docs/PRODUCTION.md)
- [API Reference](docs/API.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Security Guide](docs/SECURITY.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Coolify Guide](COOLIFY.md)
- [Deployment Checklist](DEPLOYMENT_CHECKLIST.md)

Frontend routes:

- `/dashboard`
- `/login`
- `/projects`
- `/projects/:id`
- `/databases`
- `/databases/:id`
- `/databases/:id/studio`
- `/settings`

## Repository layout

```text
backend/      API and control plane
frontend/     Admin panel scaffold
docs/         Detailed documentation
docker-compose.yml
COOLIFY.md
plan.md
```

## What this system does

At a high level, the platform stores metadata about projects and databases in a control plane, while the actual SQLite files or libsql endpoints live in the data plane.

The backend can:

- create a new SQLite file in structured storage
- import an existing SQLite file from disk
- discover `.db` files mounted on the server
- optionally adopt discovered files into the managed storage tree
- register libsql databases by URL and token
- execute safe reads and writes against SQLite/local or libsql/remote databases
- apply migrations directly to a database via API
- keep auth tokens in secure `HttpOnly` cookies in production

## Storage layout

Managed SQLite files are written to:

```text
data/sqlite/projects/<projectId>/databases/<databaseId>.db
```

This is configurable through `SQLITE_STORAGE_ROOT`.

## Quick start

1. Install backend dependencies.
2. Configure `.env` from `.env.example`.
3. Start the backend.

Example:

```bash
cd backend
npm install
npm run build
npm run start
```

## Verification

- `backend`: `npm test` for utility checks, `npm run smoke` for a live startup/sanity check
- `frontend`: `npm run build`

Dockerfile-only deploy note:

- The frontend proxies `/api/v1` to the backend container internally.
- The backend can generate and persist `MASTER_KEY` automatically at `MASTER_KEY_FILE` if you do not supply one.

## Production note

The backend cannot safely guess arbitrary databases on a remote machine. It can only manage databases that are:

- created by the platform
- imported explicitly
- discovered from a mounted directory you control
- registered by URL and token

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

The frontend admin panel is planned next.

The frontend admin panel is now scaffolded in `frontend/` and follows the same design goals: clear structure, simple operations, and production deployment through Docker/Coolify.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Usage Guide](docs/USAGE.md)
- [API Reference](docs/API.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Security Guide](docs/SECURITY.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Coolify Guide](COOLIFY.md)

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

## Production note

The backend cannot safely guess arbitrary databases on a remote machine. It can only manage databases that are:

- created by the platform
- imported explicitly
- discovered from a mounted directory you control
- registered by URL and token

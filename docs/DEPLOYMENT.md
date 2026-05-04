# Deployment Guide

## Local development

1. Copy `.env.example` to `.env` in `backend/`.
2. Set `MASTER_KEY` and any discovery/storage settings.
3. Run:

```bash
cd backend
npm install
npm run build
npm run start
```

## Docker Compose

The root `docker-compose.yml` is a starting point for local or VPS deployment.

Use it when you want:

- persistent control-plane storage
- SQLite volume persistence
- a simple single-container backend deployment

## Coolify

See [COOLIFY.md](../COOLIFY.md) for the detailed Coolify setup.

In summary:

- deploy the backend as a Docker app
- expose port `3000`
- mount `/app/data`
- configure `MASTER_KEY`
- optionally configure discovery and adoption
- add a wildcard subdomain if you want database-specific hostnames

## Recommended production volumes

- `/app/data` for control-plane DB and managed SQLite files
- an optional separate mount for raw discovered SQLite files if you want to inspect them before adoption

## Environment variables

Important variables:

- `MASTER_KEY`
- `DATABASE_FILE`
- `SQLITE_STORAGE_ROOT`
- `SQLITE_DISCOVERY_PATH`
- `SQLITE_DISCOVERY_PROJECT_ID`
- `SQLITE_DISCOVERY_ADOPT`
- `CORS_ORIGIN`

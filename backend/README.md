# Backend (API) - libsqlite

This is an initial scaffold for the API service (Fastify + TypeORM + SQLite).

Quick start (local):

1. Copy `.env.example` to `.env` and set `MASTER_KEY` (32 bytes hex).
2. Install dependencies: `npm ci`
3. Run in dev: `npm run dev` (requires `ts-node-dev`)

Notes:
- The backend currently uses opaque access tokens + refresh tokens stored in the `sessions` table.
- The project uses TypeORM with `synchronize: true` for rapid iteration. For production, switch to migrations and a proper Postgres DB.
- `MASTER_KEY` must be 32 bytes in hex (64 hex chars). It's used to encrypt database tokens.

Main endpoints:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/projects`
- `POST /api/v1/projects`
- `GET /api/v1/databases`
- `POST /api/v1/databases`
- `GET /api/v1/databases/:id/schema`
- `POST /api/v1/databases/:id/query`
- `POST /api/v1/provisioning/sqlite`
- `POST /api/v1/provisioning/libsql`
- `POST /api/v1/databases/import-sqlite`
- `GET /health`
- `GET /ready`

Operational notes:

- The backend now starts with real migrations instead of `synchronize: true`.
- Existing SQLite databases can be imported from a server-side file path and then managed like any other database.
- Security middleware includes CORS, Helmet, rate limiting, and request timing logs.

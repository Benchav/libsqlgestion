# Backend (API) - libsqlite

This is an initial scaffold for the API service (Fastify + TypeORM + SQLite).

Quick start (local):

1. Copy `.env.example` to `.env` and set `MASTER_KEY` (32 bytes hex) and `JWT_SECRET`.
2. Install dependencies: `npm ci`
3. Run in dev: `npm run dev` (requires `ts-node-dev`)

Notes:
- The project uses TypeORM with `synchronize: true` for rapid iteration. For production, switch to migrations and a proper Postgres DB.
- `MASTER_KEY` must be 32 bytes in hex (64 hex chars). It's used to encrypt database tokens.

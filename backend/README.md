# Backend (API) - libsqlite

This is an initial scaffold for the API service (Fastify + TypeORM + SQLite).

Quick start (local):

1. Copy `.env.example` to `.env` and set `MASTER_KEY` (32 bytes hex).
2. Install dependencies: `npm ci`
3. Run in dev: `npm run dev` (requires `ts-node-dev`)

Notes:
- The backend uses opaque access tokens + refresh tokens and writes them to `HttpOnly` cookies for the browser flow.
- The project uses TypeORM migrations for the control plane. For production, keep migrations enabled and back up the control database.
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
- If you mount a directory of `.db` files and set `SQLITE_DISCOVERY_PATH` plus `SQLITE_DISCOVERY_PROJECT_ID`, the backend can auto-register them at startup.
- Managed SQLite files are stored in a structured folder tree like `data/sqlite/projects/<projectId>/databases/<databaseId>.db`.
- Set `SQLITE_DISCOVERY_ADOPT=true` if you want mounted SQLite files to be copied into the managed storage tree during discovery.
- Security middleware includes CORS, Helmet, rate limiting, and request timing logs.
- Authorization is enforced both by permission and by project/database ownership membership checks.

Migrations and remote management:

- You can apply migrations directly by API against a database URL and token through the `POST /api/v1/databases/:id/migrations` endpoint.
- For libsql remote databases, the backend executes SQL using the registered URL and token.
- For local SQLite, the backend executes the SQL against the file on disk.

Production reality check:

- This backend does not magically discover every database that exists on a remote Ubuntu server.
- It can manage SQLite files that the backend can access on disk, and libsql databases that you register by URL and token.
- If you mount a directory or volume that contains SQLite files, you can import them into the control plane and manage them from the panel.
- For arbitrary remote databases, you still need a registration/import step, because the backend cannot safely infer credentials or locations by itself.

Coolify deployment:

- The project is deployable in Coolify as a Docker app because it already includes a `Dockerfile` and `docker-compose.yml` example.
- Set the environment variables from `.env.example` in Coolify, map persistent storage for `backend/data`, and expose the backend port.
- If you deploy the frontend separately later, Coolify can manage both services independently.

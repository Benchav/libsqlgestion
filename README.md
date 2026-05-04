# libsqlite (Self-hosted Turso-like)

This repository will host a self-hosted platform to manage SQLite/libsql databases.

What I added in this step:

- Initial TODO plan updated.
- Backend scaffold: Fastify + TypeORM + example entities (`User`, `Project`, `Database`).
- Auth endpoints: `/api/v1/auth/register`, `/api/v1/auth/login`, `/api/v1/me`.
- AES-256-GCM secret encrypt/decrypt utility using `MASTER_KEY`.
- Dockerfile and `docker-compose.yml` sample for local/VPS deployment.

Next steps: continue implementing DDD application services, RBAC, secrets vault integration, and provisioning flows.

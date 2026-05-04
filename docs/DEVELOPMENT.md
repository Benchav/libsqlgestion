# Development Guide

## Backend stack

- Fastify
- TypeORM
- SQLite for the control plane
- SQLite and libsql for managed databases

## Setup

```bash
cd backend
npm install
npm run build
```

## Main scripts

- `npm run dev` - development server
- `npm run build` - TypeScript build
- `npm run start` - start compiled app

## Code organization

- `src/domain` - entities and pure business rules
- `src/application` - use cases and orchestration
- `src/infrastructure` - storage, crypto, database clients, utilities
- `src/presentation` - HTTP routes, controllers, guards and plugins

## Conventions

- keep business rules out of controllers
- keep storage paths in one place
- avoid hidden side effects in route handlers
- validate inputs before calling use cases
- use audit logging for administrative actions

## Adding a new feature

1. Add or update domain entities if the model changes.
2. Add application service methods.
3. Add infrastructure helpers only when needed.
4. Expose the feature in a controller.
5. Document the endpoint in `docs/API.md`.
6. Add migration logic if the metadata schema changes.

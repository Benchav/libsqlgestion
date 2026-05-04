# Operations Manual

This manual is written for day-to-day use in production.

It focuses on the exact tasks you will repeat most often:

- onboarding the system
- creating projects and databases
- importing or discovering existing SQLite files
- applying migrations from code or CI
- operating libsql remote connections
- backing up, restoring and rotating credentials
- troubleshooting safely

## 1. Typical production layout

Recommended host paths on Ubuntu:

```text
/srv/libsqlite/
  control.db
  sqlite/
    projects/
      <projectId>/
        databases/
          <databaseId>.db
  discovered/
    legacy-app.db
```

Use this model when deploying through Coolify or Docker Compose.

## 2. First run checklist

Before you give the system to a team, confirm:

1. `MASTER_KEY` is configured.
2. Persistent storage is mounted.
3. The backend health check returns success.
4. The frontend can reach the backend API.
5. The first admin user exists.
6. Audit logs are being written.

## 3. Create a new project

Projects group databases by application, client or environment.

Example flow:

1. Log in.
2. Open the Projects page.
3. Create a project called `Billing`.
4. Use that project as the owner boundary for related databases.

API example:

```bash
curl -X POST http://localhost:3000/api/v1/projects \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Billing"}'
```

## 4. Create a new managed SQLite database

Use this when you want the platform to create the file for you.

Example API call:

```bash
curl -X POST http://localhost:3000/api/v1/databases \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId":"<projectId>",
    "name":"billing-main",
    "type":"sqlite"
  }'
```

Expected result:

- metadata is saved
- the `.db` file is created in managed storage
- a subdomain identifier is generated
- the database status becomes active

## 5. Import an existing database

Use this when you already have a `.db` file from another app or server.

Example:

```bash
curl -X POST http://localhost:3000/api/v1/databases/import-sqlite \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId":"<projectId>",
    "name":"legacy-billing",
    "sourcePath":"/srv/libsqlite/discovered/legacy-app.db"
  }'
```

Operational advice:

- import copies the database into the managed storage tree
- after import, treat the managed copy as the source of truth
- keep the original file untouched if you still need it as a fallback

## 6. Discover mounted SQLite files

Use this when a directory is mounted inside the backend container or VM.

You can scan in two modes:

### Discover only

The backend registers the database in metadata and leaves the file where it is.

### Discover and adopt

The backend copies the file into managed storage so all databases stay unified.

Example:

```bash
curl -X POST http://localhost:3000/api/v1/discovery/sqlite/adopt \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId":"<projectId>",
    "rootPath":"/app/data/sqlite"
  }'
```

Recommended use:

- discover only when you want to inspect first
- adopt when you want everything under one managed path

## 7. Register libsql remote databases

Use this for remote libsql or Turso-compatible endpoints.

Example:

```bash
curl -X POST http://localhost:3000/api/v1/provisioning/libsql \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId":"<projectId>",
    "name":"payments-remote",
    "url":"libsql://example.turso.io",
    "token":"<token>"
  }'
```

Operational advice:

- keep URL and token together in the control plane
- use token rotation when access changes
- test connectivity before using the database in production

## 8. Apply migrations from code

This is the preferred way to evolve schema without using the UI.

Example:

```bash
curl -X POST http://localhost:3000/api/v1/databases/<dbId>/migrations \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"create-users-table",
    "sql":"CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);"
  }'
```

Recommended workflow:

1. Write migrations in your codebase.
2. Run them through CI or a deployment step.
3. Keep the migration name stable and descriptive.
4. Check the migration history endpoint after execution.

## 9. Backup and restore

### Backup strategy

Back up both:

- the control plane database (`control.db`)
- the managed SQLite tree (`data/sqlite/` or your configured storage root)

### Restore strategy

1. Restore the control plane database.
2. Restore the managed SQLite files.
3. Confirm file paths match the expected storage layout.
4. Verify health and readiness endpoints.

## 10. Token rotation

Rotate tokens when:

- a credential is exposed
- a team member leaves
- you want scheduled refreshes

Endpoint:

- `PATCH /api/v1/databases/:id/rotate-token`

## 11. Permission model

Use roles to separate responsibilities:

- `superadmin` for full control
- `admin` for normal operations
- `operator` for day-to-day database work
- `readonly` for audit or inspection

Best practice:

- do not use superadmin for everyday work
- restrict `databases.write` and `users.write` to trusted operators only

## 12. Troubleshooting routine

If something fails, check in this order:

1. `GET /health`
2. `GET /ready`
3. control plane DB permissions
4. storage volume permissions
5. environment variables
6. audit logs
7. database connection details

## 13. Safe operating habits

- manage only what you explicitly register, import or discover
- keep one storage root per environment
- prefer managed storage over scattered ad hoc files
- use migrations instead of manual schema edits
- record all sensitive actions in audit logs

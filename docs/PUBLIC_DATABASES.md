# Public Database Hosting Guide

This guide explains how to run LibSQLite as a fully self-hosted replacement for Turso-style workflows.

The goal is simple:

- create or import databases in the panel
- publish each database with a public URL
- manage wildcard subdomains from the panel UI
- keep tokens and real domains out of the repository
- consume the database from another backend such as `api.example.com`
- keep control of the whole stack inside your own server, Coolify, and Cloudflare

## 1. What this project does

LibSQLite manages the control plane for SQLite and libSQL databases.

It can:

- create databases with generated tokens
- import SQLite files from disk or upload
- store token secrets encrypted
- expose panel-managed connection URLs
- provision a per-database libSQL runtime when Docker is available
- let your backend use the URL + token pair exactly like a Turso database

## 2. What still needs infrastructure

The project generates the connection data, but your infrastructure decides how that URL becomes reachable.

You still need:

- a public hostname in Cloudflare
- a Coolify app or reverse proxy that receives traffic
- Docker socket access if you want per-database libSQL runtimes
- persistent storage for the control plane and database files

The panel now stores the public database routing settings itself. Coolify environment variables are still supported as bootstrap defaults and fallback values.

If you want a public URL such as `https://db-1.db.example.com`, that hostname must resolve to something reachable from your backend and from any external client that uses the database.

## 3. Recommended topology

Use this structure:

- `panel.example.com` -> LibSQLite control panel
- `api.example.com` -> your ERP or backend
- `db.example.com` -> database entry point or wildcard parent domain
- `*.db.example.com` -> optional wildcard subdomains if you want one host per database

The intended setup for this project is subdomain-based public URLs with a dedicated database domain.

Use this if you want a Turso-like experience.

In practice, you keep your main app on `panel.example.com` or `api.example.com`, and you give databases their own parent host such as `db.example.com`.

Example:

- `https://legacy-orders.db.example.com`
- `https://inventory-main.db.example.com`

Configure:

- `DATABASE_PUBLIC_DOMAIN=db.example.com`
- `DATABASE_PUBLIC_PROTOCOL=http`

This mode is the most similar to Turso, but it requires your proxy/DNS layer to route wildcard hostnames correctly.

## 4. Environment variables

Set these in Coolify for the backend service:

```env
MASTER_KEY=<64 hex chars>
DATABASE_FILE=/app/data/control.db
PORT=3000
CORS_ORIGIN=https://panel.example.com
SQLITE_STORAGE_ROOT=/app/data/sqlite
SQLITE_DISCOVERY_PATH=/app/data/sqlite
SQLITE_DISCOVERY_PROJECT_ID=<project-id>
SQLITE_DISCOVERY_ADOPT=true

# Choose one URL strategy
DATABASE_PUBLIC_DOMAIN=db.example.com
DATABASE_PUBLIC_URL_TEMPLATE=
DATABASE_PUBLIC_BASE_URL=

# Docker runtime networking
DATABASE_PUBLIC_HOST=db.example.com
DATABASE_PUBLIC_PROTOCOL=http
DOCKER_SOCKET_PATH=/var/run/docker.sock
LIBSQL_SERVER_IMAGE=ghcr.io/tursodatabase/libsql-server:latest
```

### Variable meaning

- `MASTER_KEY` encrypts stored database tokens.
- `SQLITE_STORAGE_ROOT` is where managed `.db` files live.
- `SQLITE_DISCOVERY_PATH` scans existing files for import/discovery.
- `SQLITE_DISCOVERY_ADOPT=true` copies discovered files into managed storage.
- `DATABASE_PUBLIC_DOMAIN` enables wildcard subdomain-style URLs.
- `DATABASE_PUBLIC_URL_TEMPLATE` and `DATABASE_PUBLIC_BASE_URL` remain available as advanced fallbacks, but the main flow is wildcard subdomains.
- `DATABASE_PUBLIC_HOST` is the hostname that the runtime uses when publishing a database.
- `DATABASE_PUBLIC_PROTOCOL` is `http` because Cloudflare handles TLS externally.

## 4.1. Panel-managed routing settings

After the backend starts, open the Settings page in the panel and configure **Public Database Routing**.

You can edit there:

- wildcard domain

The panel keeps the rest of the behavior implicit so you only manage your main domain.

The panel stores those values in the control plane, and the backend uses them when it generates public URLs and when it provisions managed libSQL runtimes.

If a field is left blank in the panel, the backend falls back to the Coolify environment variable.

## 5. Cloudflare setup

Use Cloudflare for DNS and TLS, and keep all real values in your zone settings, not the repository.

### Option A. Single public database endpoint

Use this when you want path-based URLs.

1. Create a DNS record for `db.example.com`.
2. Point it to your Cloudflare Tunnel hostname or the public proxy endpoint for your Coolify host.
3. Enable proxying so Cloudflare manages TLS.
4. Configure your backend with `DATABASE_PUBLIC_BASE_URL=https://db.example.com`.

### Option B. Wildcard subdomains

Use this when you want one public host per database.

1. Create a wildcard DNS record for `*.db.example.com` if your Cloudflare plan and routing model support it.
2. Route that wildcard hostname to the proxy or tunnel that can reach your libSQL runtime.
3. Make sure the proxy layer can route or forward requests for each database hostname to the correct runtime target.
4. Configure your backend with `DATABASE_PUBLIC_DOMAIN=db.example.com`.

### Cloudflare Tunnel notes

If you are using Cloudflare Tunnel:

- create a public route for `panel.example.com` to the LibSQLite panel
- create a route for the database hostname or wildcard hostname
- keep the database hostname resolvable from your ERP server and from your local editor

If the hostname cannot be resolved from your ERP backend, the connection test will fail even if the panel looks correct.

### Example DNS model

```text
panel.example.com      -> LibSQLite panel
api.example.com        -> ERP API
db.example.com         -> database entry point
*.db.example.com       -> optional wildcard database hostnames
```

## 6. Coolify setup

Create a Docker app in Coolify using the backend service.

Recommended settings:

- Dockerfile: `backend/Dockerfile`
- Exposed port: `3000`
- Health check path: `/health`
- Persistent volume: `/app/data`
- Docker socket mounted if you want Docker-based libSQL runtimes

### Coolify environment example

```env
MASTER_KEY=<64 hex chars>
DATABASE_FILE=/app/data/control.db
PORT=3000
CORS_ORIGIN=https://panel.example.com
SQLITE_STORAGE_ROOT=/app/data/sqlite
SQLITE_DISCOVERY_PATH=/app/data/sqlite
SQLITE_DISCOVERY_PROJECT_ID=<project-id>
SQLITE_DISCOVERY_ADOPT=true
DATABASE_PUBLIC_DOMAIN=db.example.com
DATABASE_PUBLIC_HOST=db.example.com
DATABASE_PUBLIC_PROTOCOL=https
DOCKER_SOCKET_PATH=/var/run/docker.sock
```

### Coolify storage

Mount `/app/data` so the control database and managed SQLite files survive redeploys.

Suggested layout:

```text
/app/data/
  control.db
  sqlite/
    projects/
      <projectId>/
        databases/
          <databaseId>.db
```

### Coolify networking checklist

- confirm the app is reachable by the domain you configured in Cloudflare
- confirm Docker socket access if using per-database libSQL containers
- confirm the backend can resolve the public host configured in `DATABASE_PUBLIC_HOST`
- confirm the same host is reachable from your ERP backend

## 6.1. Exact implementation order

Use this order if you want the same experience Coolify gives you for apps, but applied to databases:

1. Configure Cloudflare DNS first.
  - Create `panel.example.com` for the panel.
  - Create `db.example.com` for database traffic.
  - Optionally create a wildcard record for `*.db.example.com` if your routing model supports it.
2. Deploy the LibSQLite backend in Coolify.
  - Mount `/app/data`.
  - Mount the Docker socket if you want managed libSQL runtimes per database.
  - Expose the backend on port `3000`.
3. Open the panel and go to `Settings -> Public Database Routing`.
  - Set only `Wildcard domain` to your dedicated database domain, such as `db.example.com`.
  - The panel will generate `http://<database>.db.example.com` for each database.
4. Create or import a database.
  - Leave the `Subdomain` field blank if you want the backend to auto-generate it.
  - The backend will build the public URL using the panel settings.
5. Copy the URL and token from the database detail page.
  - Use them in your ERP backend environment variables.
  - Treat that pair like the Turso connection tuple.
6. Test the connection from the ERP backend.
  - Run a simple `SELECT 1`.
  - Then run your migrations.

If you want the shortest path to production, use the wildcard domain approach and keep the panel routing fields as the source of truth.

## 7. Database workflow in the panel

### Create a database

1. Open the Databases section.
2. Choose a project.
3. Create a new SQLite database.
4. Leave the subdomain field blank if you want auto-generation.
5. Copy the URL and token from the detail page.
6. If needed, first configure wildcard routing in **Settings -> Public Database Routing**.

### Import a database

1. Open the import dialog.
2. Upload a `.db`, `.sqlite`, or `.sqlite3` file, or use a server path.
3. Leave the subdomain field blank if you want auto-generation.
4. After import, copy the URL and token.
5. If needed, first configure wildcard routing in **Settings -> Public Database Routing**.

### What to expect

- If Docker runtime provisioning succeeds, the panel shows a `docker-libsql` runtime.
- If Docker is unavailable, the backend falls back to `local-file` mode.
- `local-file` is functional inside this project, but it is not the same as a remotely consumable libSQL endpoint.
- The public URL is always derived from the panel routing settings, not manually typed into each database record.
- The public URL is derived from the wildcard domain in the panel and defaults to HTTP internally.

## 8. Integration examples

### Next.js API route

This is the most common use case for your ERP or another app.

```ts
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN!,
});

export async function GET() {
  const result = await client.execute('SELECT 1 AS ok');
  return Response.json({ rows: result.rows });
}
```

### Migration script

Use this from CI, your backend, or a one-off script.

```ts
import { createClient } from '@libsql/client';

async function run() {
  const client = createClient({
    url: process.env.DATABASE_URL!,
    authToken: process.env.DATABASE_AUTH_TOKEN!,
  });

  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  client.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

### Environment variables for your ERP backend

```env
DATABASE_URL=https://inventory-main.db.example.com
DATABASE_AUTH_TOKEN=xxxxx
```

For path-based deployments, the URL will look like this instead:

```env
DATABASE_URL=https://db.example.com/inventory-main
DATABASE_AUTH_TOKEN=xxxxx
```

## 9. Validation checklist

Use this list before calling the setup production-ready:

- the panel can create a project
- the panel can create or import a database
- the database detail page shows a URL and token
- the runtime is `docker-libsql` if you want a remote endpoint
- the URL resolves from your ERP backend
- `SELECT 1` works from your ERP backend using the copied token
- migrations can be executed from your code, not only from the panel

## 10. Troubleshooting

### URL exists in the panel but cannot be used externally

Usually means one of these:

- Cloudflare DNS is missing
- the wildcard hostname is not routed to the backend/proxy
- the backend is generating a URL that your network cannot resolve
- the runtime is `local-file`, not a remote libSQL endpoint

### Docker runtime fails

Check:

- Docker socket mount
- public host name
- runtime image availability
- backend network access to the published port

### Import succeeds but the URL is not public

That means the storage import worked, but the hostname routing did not.

Fix the Cloudflare/Coolify routing, not the database file itself.

## 11. Source of truth

Keep real domains, hostnames, and tokens only in:

- Coolify environment variables
- Cloudflare DNS / Tunnel configuration
- the LibSQLite panel database detail page

Do not commit real domains or tokens into the repository.
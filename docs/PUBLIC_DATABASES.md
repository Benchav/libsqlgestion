# Public Database Hosting Guide

This guide explains how to run LibSQLite as a fully self-hosted replacement for Turso-style workflows, specifically optimized for deployments using **Coolify**, **Traefik**, and **Cloudflare Tunnels**.

The goal is to provide a zero-configuration developer experience where:
- You create or import databases in the panel.
- The system automatically provisions a `libsql-server` Docker container.
- Traefik automatically discovers the container and routes traffic to it using dynamic subdomains.
- Cloudflare Tunnel securely exposes these subdomains to the public internet with HTTPS.

## 1. Architecture Overview

When you create a database, LibSQLite orchestrates the following:

1. **Storage**: It allocates a dedicated directory for the database file at `/app/data/sqlite/projects/[projectId]/databases/[databaseId]/dbs/default/data`. This exact path is required because `libsql-server` internally expects its database to reside in `dbs/default/data`.
2. **Container Provisioning**: It spawns a `ghcr.io/tursodatabase/libsql-server` container attached to your backend network (e.g., `coolify`).
3. **Dynamic Proxying (Traefik)**: It injects `traefik.http.routers` Docker labels into the new container. Traefik (which comes built-in with Coolify) instantly reads these labels and begins routing traffic for `[subdomain].[your-domain]` directly to the container's internal port `8080`.
4. **Authentication**: It generates a secure JWT token using ED25519 keys, passing the public key to the container.

## 2. Cloudflare Zero Trust (Tunnels) Setup

To expose your local Traefik proxy securely without opening ports on your router or VPS, use **Cloudflare Tunnels**.

### 🚨 CRITICAL: The Cloudflare Free Plan "SSL Trap"
If you are on the **Free Plan** of Cloudflare, the provided Universal SSL certificate **only covers one level of subdomains** (e.g., `*.ibarrera.site`). 
- ✅ `https://inventario.ibarrera.site` (Covered)
- ❌ `https://inventario.db.ibarrera.site` (NOT covered. Will throw an SSL Error).

**GOLDEN RULE**: Do not use `db.yourdomain.com` as your routing domain in LibSQLite if you are on the Free Plan. Use your root domain (`yourdomain.com`). This ensures generated URLs like `https://my-db.yourdomain.com` are protected by Free SSL natively.

### Tunnel Routing Rules (The "Secret Sauce")
In your Cloudflare Zero Trust Dashboard, under **Public Hostnames**, you must route the wildcard domain directly to **Traefik**, NOT to the internal database ports.

| Public Hostname | Service |
| :--- | :--- |
| `*.yourdomain.com` | `http://127.0.0.1:80` (or your Traefik host IP) |

*Why port 80?* Cloudflare Tunnel must forward the traffic to **Traefik**. Traefik lives on port 80, reads the `Host` header (e.g., `my-db.yourdomain.com`), and acts as the smart bridge, internally routing the traffic to the dynamically generated port of the correct `libsql-server` container.

## 3. Coolify Setup

Deploy the LibSQLite backend in Coolify as a Docker Compose or Nixpacks app.

### Required Environment Variables
```env
# Core settings
MASTER_KEY=<64 hex chars>
DATABASE_FILE=/app/data/control.db
PORT=3000

# Docker Socket (Mandatory for spawning libSQL containers)
DOCKER_SOCKET_PATH=/var/run/docker.sock

# Routing settings
DATABASE_PUBLIC_PROTOCOL=https
DATABASE_PUBLIC_DOMAIN=yourdomain.com
```

### Storage Mounts
You must mount `/app/data` to a persistent volume in Coolify.
```text
/app/data/
  control.db
  sqlite/
    projects/
      <projectId>/
        databases/
          <databaseId>/
            dbs/
              default/
                data      <-- The actual SQLite file shared by Studio and libsql-server
                data-wal
```

*Note: In previous versions, databases were stored as flat `.sqlite` files. This caused architecture conflicts where the panel read the file, but `libsql-server` served an empty internal database. This has been permanently fixed.*

## 4. LibSQLite Panel Configuration (Crucial Step)

Once deployed, open your LibSQLite Panel to tell the backend how to build your public URLs and Traefik rules:

1. Go to **Settings > Public Database Routing**.
2. **Wildcard domain**: Set this strictly to your root domain (e.g., `yourdomain.com`) to avoid the Cloudflare Free Plan SSL limit mentioned above.
3. **Protocol**: Set this to `https` (Cloudflare handles the secure termination).

Now, whenever you create or import a database, the panel will dynamically inject Traefik labels into the container using this domain and generate a public `URL` like `https://[database-name].yourdomain.com`.

### Runtime health expectation
Managed public databases are considered healthy only when LibSQLite can verify all of the following:

1. the `libsql-server` container is running
2. the internal runtime URL responds
3. the backend-reachable URL responds
4. the public subdomain responds when a real public domain is configured

If any of these checks fail during provisioning, the database stays in an error state instead of silently degrading to a local-only runtime.

## 5. Using the Database in your ERP / API

Once your database is created and active, you can consume it exactly like a Turso database. **No code changes are required in your application.**

### Environment Variables in your App
```env
TURSO_DATABASE_URL=https://[database-name].yourdomain.com
# OR using WebSockets
TURSO_DATABASE_URL=libsql://[database-name].yourdomain.com

TURSO_AUTH_TOKEN=eyJhbGciOiJFZERTQSIsInR...
```

LibSQLite now also exposes a public HTTPS URL and a public `libsql://` URL separately in the panel. Prefer the `libsql://` URL for production clients that support it, and use the HTTPS URL as a fallback.

### Optional production runtime flags
You can further tune a production deployment with these optional environment variables:

```env
# Runtime token TTL in seconds
LIBSQL_RUNTIME_TOKEN_TTL_SECONDS=2592000

# Optional in-process async provisioning for managed public runtimes
LIBSQL_PROVISION_ASYNC=false

# SQLite tuning profile: safe | balanced | performance
SQLITE_PERFORMANCE_PROFILE=performance

# Optional explicit SQLite tuning overrides
SQLITE_BUSY_TIMEOUT_MS=2500
SQLITE_CACHE_SIZE=-80000
SQLITE_MMAP_SIZE=1073741824
SQLITE_SYNCHRONOUS=NORMAL
SQLITE_TEMP_STORE=MEMORY

# Backend pool tuning
DB_CONNECTION_POOL_MAX_SIZE=256
DB_CONNECTION_POOL_IDLE_TTL_MS=1800000
```

### Troubleshooting a 500 Error
If your API returns a `500 Internal Server Error` when connecting to a newly imported database:
1. **Check the protocol**: Ensure your ERP `.env` uses `https://` or `libsql://`. If you use `http://`, Cloudflare will issue a 301 Redirect that drops the Auth Token, causing a `401 Unauthorized` in the backend.
2. **Check your tables**: Ensure you have run your database migrations (`npx prisma db push`, `npm run db:push`, etc.) against the new URL. The 500 error is often caused by your backend executing `SELECT * FROM users` on a database that doesn't have a `users` table yet.

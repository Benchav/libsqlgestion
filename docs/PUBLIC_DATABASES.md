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

###  CRITICAL: The Cloudflare Free Plan "SSL Trap"
If you are on the **Free Plan** of Cloudflare, the provided Universal SSL certificate **only covers one level of subdomains** (e.g., `*.ibarrera.site`). 
-  `https://inventario.ibarrera.site` (Covered)
-  `https://inventario.db.ibarrera.site` (NOT covered. Will throw an SSL Error).

**Solution**: Do not use `db.yourdomain.com` as your routing domain in LibSQLite. Use your root domain (`yourdomain.com`). This ensures generated URLs like `https://my-db.yourdomain.com` are protected by Free SSL.

### Tunnel Routing Rules
In your Cloudflare Zero Trust Dashboard, under **Public Hostnames**, create a wildcard route:

| Public Hostname | Service |
| :--- | :--- |
| `*.yourdomain.com` | `http://127.0.0.1:80` (or your Traefik host IP) |

*Why port 80?* Because Cloudflare Tunnel must forward the traffic to **Traefik**, not to the individual databases. Traefik listens on port 80, reads the `Host` header (e.g., `my-db.yourdomain.com`), and acts as the smart bridge to the correct random port of the `libsql-server` container.

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

## 4. LibSQLite Panel Configuration

Once deployed, open your LibSQLite Panel:

1. Go to **Settings > Public Database Routing**.
2. Set the **Wildcard domain** to your root domain (e.g., `yourdomain.com`).
3. Set the **Protocol** to `https`.

Now, whenever you create or import a database, the panel will generate a `PUBLIC URL` like `https://[database-name].yourdomain.com`.

## 5. Using the Database in your ERP / API

Once your database is created and active, you can consume it exactly like a Turso database. **No code changes are required in your application.**

### Environment Variables in your App
```env
TURSO_DATABASE_URL=https://[database-name].yourdomain.com
# OR using WebSockets
TURSO_DATABASE_URL=libsql://[database-name].yourdomain.com

TURSO_AUTH_TOKEN=eyJhbGciOiJFZERTQSIsInR...
```

### Troubleshooting a 500 Error
If your API returns a `500 Internal Server Error` when connecting to a newly imported database:
1. **Check the protocol**: Ensure your ERP `.env` uses `https://` or `libsql://`. If you use `http://`, Cloudflare will issue a 301 Redirect that drops the Auth Token, causing a `401 Unauthorized` in the backend.
2. **Check your tables**: Ensure you have run your database migrations (`npx prisma db push`, `npm run db:push`, etc.) against the new URL. The 500 error is often caused by your backend executing `SELECT * FROM users` on a database that doesn't have a `users` table yet.
<div align="center">
  <img src="./docs/assets/banner.png" alt="LibSQLite Banner" width="100%" />
  <br />
  <img src="./docs/assets/logo.png" alt="LibSQLite Logo" width="120" height="120" />

  # LibSQLite V1

  **The self-hosted, Turso-like control plane for SQLite & libSQL.**

  <p>
    <a href="#features">Features</a> •
    <a href="#quick-start">Quick Start</a> •
    <a href="#documentation">Documentation</a> •
    <a href="#architecture">Architecture</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/status-active-success.svg?style=flat-square" alt="Status" />
    <img src="https://img.shields.io/badge/Node.js-Fastify-blue.svg?style=flat-square" alt="Backend" />
    <img src="https://img.shields.io/badge/Next.js-App%20Router-black.svg?style=flat-square" alt="Frontend" />
    <img src="https://img.shields.io/badge/Docker-Ready-2496ED.svg?style=flat-square" alt="Docker" />
    <img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License" />
  </p>
</div>

---

## What is LibSQLite?

LibSQLite brings the modern developer experience of serverless databases to your own infrastructure. It is a powerful, **100% self-hosted open-source alternative to Turso**, designed to orchestrate, manage, and scale SQLite and libSQL databases at the edge.

Instead of paying for managed cloud services or struggling with monolithic setups, LibSQLite provides a zero-configuration control plane that dynamically spins up isolated `libsql-server` containers, automatically routes traffic via Traefik, and exposes them securely through Cloudflare Tunnels using single-level wildcard subdomains.

<br>

## Key Features

- **Dynamic Docker Orchestration**: Automatically provisions isolated `libsql-server` containers for every database you create or import.
- **Zero-Config Edge Routing**: Native integration with **Traefik** and **Cloudflare Tunnels**. Expose databases instantly to the public internet securely (e.g., `https://my-db.yourdomain.com`).
- **Unified Management Panel**: Govern multiple SQLite databases from an intuitive, unified dark-mode dashboard.
- **Built-in Studio**: Powerful schema browsing, data visualization, and raw query execution built right into the interface (synchronizes perfectly with your active `libsql-server` instances).
- **Migration Engine**: Apply, track, and execute safe migrations directly from code, CI/CD, or the API.
- **Enterprise-Grade Security**: Full RBAC, encrypted token storage via ED25519 JWT keys, comprehensive audit logging, and `HttpOnly` session hardening.
- **Deploy Anywhere**: First-class support for local servers, VPS, and zero-config deployment on **Coolify**.

<br>

## Quick Start

Get up and running with LibSQLite in seconds using Docker Compose or Node.js.

### Option A: Running with Docker (Recommended)

LibSQLite ships with a robust `docker-compose.yml` for effortless production or local deployment.

```bash
# Start the entire stack (Backend on port 5000, Frontend on 5001)
docker-compose up -d --build
```
> The backend automatically generates and persists a secure `MASTER_KEY` if none is supplied. 

### Option B: Local Development

```bash
# 1. Install backend dependencies and configure env
cd backend
npm install
cp .env.example .env

# 2. Build and start the backend service
npm run build
npm run start

# 3. In a new terminal, start the Next.js frontend
cd ../frontend
npm install
npm run dev
```

<br>

## Architecture Overview

At its core, LibSQLite enforces a strict separation between the **Control Plane** (Backend metadata and management) and the **Data Plane** (Actual SQLite/libSQL files and orchestrated containers).

```mermaid
graph TD;
    A[Cloudflare Tunnel / Edge] -->|Wildcard Subdomains| B(Traefik Proxy);
    B -->|Dynamic HTTP Routing| C((Isolated libsql-server Containers));
    B -->|Panel Traffic| D[LibSQLite Control Plane];
    D -->|Manages| C;
    D -->|Reads/Writes| E[(Shared sqlite data volume)];
    C -->|Serves| E;
```

**Storage Layout (Optimized for `libsql-server`)**
Managed SQLite files are securely structured so that the built-in Studio and the orchestrated Docker containers remain in perfect sync:
```text
data/sqlite/projects/<projectId>/databases/<databaseId>/dbs/default/data
```

<br>

## Documentation

Deep-dive into our extensive guides to master your self-hosted infrastructure:

| Getting Started | Operations | Architecture |
| :--- | :--- | :--- |
| [Usage Guide](docs/USAGE.md) | [Production Guide](docs/PRODUCTION.md) | [Architecture](docs/ARCHITECTURE.md) |
| [Development Guide](docs/DEVELOPMENT.md) | [Security Guide](docs/SECURITY.md) | [API Reference](docs/API.md) |
| [Deployment Guide](docs/DEPLOYMENT.md) | [Coolify Guide](COOLIFY.md) | [Public Database Guide](docs/PUBLIC_DATABASES.md) |
| [Deploy Checklist](DEPLOYMENT_CHECKLIST.md) | [Troubleshooting](docs/TROUBLESHOOTING.md) | |

<br>

## Tech Stack

- **Frontend**: Next.js 14+ (App Router), React, Tailwind CSS, Lucide Icons.
- **Backend**: Node.js, Fastify, TypeORM, `@libsql/client`.
- **Security**: Argon2 Encryption, Helmet, Rate-Limiting.
- **Infrastructure**: Docker, Coolify.

<br>

---

<div align="center">
  Built for developers who demand control over their data.<br>
  Created by <b><a href="https://joshuachavez.vercel.app" target="_blank">Joshua Chávez Lau</a></b><br><br>
  <b><a href="#">Report Bug</a></b> • <b><a href="#">Request Feature</a></b>
</div>

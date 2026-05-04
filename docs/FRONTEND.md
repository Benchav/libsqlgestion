# Frontend Guide

The frontend lives in `frontend/` and is built with Next.js.

## Goals

- provide a clean admin experience
- keep the UI easy to understand for operators
- separate API concerns from presentation concerns
- support Docker and Coolify deployment

## Pages

- `/` landing page
- `/login` authentication
- `/dashboard` system overview
- `/projects` project management
- `/databases` database management and import
- `/audit` audit log
- `/settings` environment and system notes

## Authentication model

The frontend stores the access token and refresh token in browser storage after login.

The backend still remains the source of truth for authentication and permissions.

## Configuration

Environment variables:

```env
NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1
```

## Local run

```bash
cd frontend
npm install
npm run build
npm run start
```

## Deployment

The frontend includes its own `Dockerfile`, so it can be deployed as a separate Coolify app if you want to split UI and API.

## Design notes

The UI uses:

- a glassmorphism-style control layout
- strong hierarchy for operational dashboards
- readable cards and tables
- responsive layout for laptop and desktop first

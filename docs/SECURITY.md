# Security Guide

## Authentication

The backend uses session-based authentication with opaque access and refresh tokens.

## Password storage

Passwords are hashed with `argon2id`.

## Secret storage

Database tokens are encrypted with `MASTER_KEY` using AES-256-GCM.

## API protections

- rate limiting
- Helmet security headers
- CORS restriction through configuration
- audit logging for sensitive operations

## Operational rules

- never commit secrets to the repository
- rotate `MASTER_KEY` carefully because it affects token decryption
- back up the control-plane database and managed SQLite files separately
- use the audit log for user and database operations

## Safe import/discovery model

The backend only manages databases that are explicitly created, imported, discovered from a mounted path or registered by URL and token.

It does not infer credentials from arbitrary servers.

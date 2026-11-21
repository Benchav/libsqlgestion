# Policy Gateway for Direct libSQL Clients

The policy gateway makes **Block Reads** and **Block Writes** effective for
clients that connect directly to a managed libSQL database, without sending
their SQL through the control-plane API.

## Why it exists

The panel and its HTTP pipeline already enforce the protection flags. Dedicated
`docker-libsql` runtimes and `sqld-namespace` databases also expose a direct
public URL:

```text
libsql://<database-host>
```

Traffic on that URL goes from Traefik to the runtime, not through the backend.
The panel cannot inspect or block it.

The gateway adds a second, policy-aware path on the **same host**:

```text
https://<database-host>/gateway/
libsql://<database-host>/gateway/
```

That path is routed by Traefik to the gateway, which parses Hrana requests,
applies the database flags, and only then forwards to the runtime.

## What is enforced

- `execute`
- `batch`
- `sequence`
- `store_sql` followed by `execute` using `sql_id`
- transactions using Hrana batons, including `store_sql` state
- legacy `POST /` batches with `statements`
- `describe` is allowed because it prepares metadata and does not execute the
  statement
- `base_url` returned by the runtime is rewritten to `null`, so the client does
  not switch to an internal URL and bypass the gateway

Blocked requests return `403` with `DATABASE_READS_BLOCKED` or
`DATABASE_WRITES_BLOCKED` before the runtime sees them.

## Important limitations

### The direct URL still exists

This phase does **not** remove the runtime's original public route. A client
still using `libsql://<database-host>` without `/gateway/` bypasses the gateway.

The ERP must be updated to the Gateway URL shown in the database detail page.
Removing the direct route requires a maintenance phase that recreates the
runtime without public Traefik labels and without published host ports.

### WebSocket is rejected

The gateway supports Hrana HTTP v2 (`/v2/pipeline`). WebSocket upgrades return
`501 GATEWAY_WEBSOCKET_UNSUPPORTED` rather than being proxied without policy.
The `@libsql/client` HTTP client does not need WebSocket.

Hrana v3 protobuf endpoints are not parsed. A client that probes v3 receives a
404 and can fall back to v2, as the tested `@libsql/client` HTTP client does. If
your ERP forces v3 protobuf, the gateway is not compatible yet and must be
extended before use.

Compressed request or response bodies are rejected with
`GATEWAY_UNSUPPORTED_ENCODING` so the gateway never forwards an uninspected SQL
payload.

### Embedded replicas are not covered

If an application uses `TURSO_DATABASE_URL=file:...` plus
`TURSO_SYNC_URL=libsql://...`, reads happen from the local replica. A gateway on
the server cannot block local reads. Use a direct remote client if full read
enforcement is required.

### Gateway restarts invalidate open batons

Stored SQL state is held in gateway memory. If the gateway restarts, a client
with an open baton and `sql_id` references receives
`409 GATEWAY_STREAM_STATE_LOST`. The application should retry the transaction
from the beginning.

### Policy availability

The gateway fetches policy from the backend internal endpoint. It caches the
policy briefly. If the backend is unavailable:

- a cached policy is used while it is fresh enough;
- otherwise the gateway fails closed with `503 GATEWAY_POLICY_UNAVAILABLE`.

### Fail-closed routing

The gateway is mounted on `PathPrefix('/gateway')` with a higher Traefik
priority than the runtime root route. If the gateway is down, `/gateway/...`
does not fall back to `/...`; direct SQL execution on the gateway path is not
possible.

## Configuration

Backend environment:

```dotenv
DATABASE_GATEWAY_ENABLED=true
DATABASE_GATEWAY_PATH=/gateway/
GATEWAY_INTERNAL_TOKEN=<long-random-secret>
GATEWAY_BACKEND_INTERNAL_URL=http://backend:5000
```

Gateway service environment:

```dotenv
GATEWAY_PORT=8081
GATEWAY_POLICY_URL=http://backend:5000/api/v1/internal/gateway/policy
GATEWAY_INTERNAL_TOKEN=<same-secret>
GATEWAY_PATH_PREFIX=/gateway
GATEWAY_BODY_LIMIT_BYTES=33554432
GATEWAY_POLICY_TTL_MS=1000
GATEWAY_POLICY_MAX_STALE_MS=5000
GATEWAY_UPSTREAM_TIMEOUT_MS=120000
GATEWAY_LOG_REQUESTS=false
```

Both services must share the Docker network that contains Traefik, the backend
and the runtime containers. If you use a custom `LIBSQL_RUNTIME_NETWORK`, attach
the gateway service to that same network as well; otherwise it cannot resolve
`libsqlite-<database-id>` or `sqld`.

The gateway image is the backend image with a different command:

```text
node dist/gateway/main.js
```

`docker-compose.yml` includes a `gateway` service with the `/gateway`
PathPrefix router. If you deploy with Coolify or another orchestrator, create an
equivalent service and route `/gateway` to port `8081`. TLS can use the
existing wildcard certificate for the database host. If your Traefik uses a
custom entrypoint or certificate resolver, add the corresponding
`traefik.http.routers.libsqlite-gateway.entrypoints` and
`traefik.http.routers.libsqlite-gateway.tls.certresolver` labels with literal
values for your environment.

## Activation procedure

1. Set `GATEWAY_INTERNAL_TOKEN` to a long random secret and set
   `DATABASE_GATEWAY_ENABLED=true` on the backend.
2. Deploy the backend and gateway services.
3. Confirm that `https://<database-host>/gateway/__health` reaches the gateway
   and returns `{"ok":true}`. Do not expose the internal policy endpoint.
4. Open the database detail page. A **Gateway URL · full enforcement** block
   should appear.
5. In the ERP, replace:

   ```text
   TURSO_DATABASE_URL=libsql://<database-host>
   ```

   with:

   ```text
   TURSO_DATABASE_URL=libsql://<database-host>/gateway/
   ```

   Keep the same token. If the ERP also sets `TURSO_SYNC_URL`, update it to the
   Gateway URL as well or remove it when not using an embedded replica.
6. Restart the ERP and verify normal reads.
7. Enable Block Writes and verify that a sale fails with a `403` before any
   data is written.
8. Enable Block Reads and verify that a direct `SELECT` fails.
9. Monitor gateway logs for `blocked=true`, upstream errors and latency.
10. Keep the direct URL documented as a bypass. Do not assume it is closed.

## Rollback

Change the ERP URL back to the direct URL and disable the gateway route. This
does not recreate the runtime and does not change the database token.

## Next phase: internalize the runtime

To remove the direct-URL bypass, the runtime must stop receiving public traffic:

- remove the runtime's public Traefik labels;
- stop publishing its HTTP port on the host;
- keep only the gateway's public route;
- provide a documented emergency procedure to re-expose the runtime.

That operation requires a controlled runtime recreation and should be done in a
maintenance window, one database at a time.

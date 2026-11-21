import crypto from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { In } from 'typeorm';
import { z } from 'zod';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { Database } from '../../../domain/entities/Database';
import { getRuntimeProvider, resolveEffectiveDatabaseType } from '../../../application/databases/database-runtime';
import { analyticsCollector } from '../../../application/analytics/AnalyticsCollector';
import { parseAndValidate } from '../../../types/validations';

const gatewayAnalyticsSchema = z.object({
  queries: z.array(z.object({
    databaseId: z.string().uuid(),
    sql: z.string().min(1).max(20_000),
    durationMs: z.number().int().min(0).max(3_600_000),
    rowsRead: z.number().int().min(0).max(1_000_000_000_000).optional(),
    rowsWritten: z.number().int().min(0).max(1_000_000_000_000).optional(),
    success: z.boolean().optional(),
    errorCode: z.string().max(128).optional(),
  })).max(500).default([]),
  traffic: z.array(z.object({
    databaseId: z.string().uuid().optional(),
    method: z.string().min(1).max(16),
    path: z.string().min(1).max(2048),
    requestBytes: z.number().int().min(0).max(1_000_000_000_000).optional(),
    responseBytes: z.number().int().min(0).max(1_000_000_000_000).optional(),
    statusCode: z.number().int().min(0).max(599).optional(),
    durationMs: z.number().int().min(0).max(3_600_000).optional(),
  })).max(500).default([]),
}).strict();

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeHost(value: unknown) {
  return String(value || '')
    .split(',')[0]
    .trim()
    .split(':')[0]
    .replace(/\.$/, '')
    .toLowerCase();
}

function normalizeBase(value: string) {
  return value.replace(/\/+$/, '');
}

export default async function gatewayRoutes(app: FastifyInstance) {
  const databaseRepo = AppDataSource.getRepository(Database);

  app.get('/internal/gateway/policy', async (request: FastifyRequest, reply: FastifyReply) => {
    const expectedToken = process.env.GATEWAY_INTERNAL_TOKEN?.trim();
    if (!expectedToken) {
      return reply.status(503).send({
        error: 'gateway policy is not configured',
        code: 'GATEWAY_POLICY_DISABLED',
      });
    }

    const provided = request.headers['x-gateway-token'];
    const providedToken = Array.isArray(provided) ? provided[0] : provided;
    if (!providedToken || !safeEqual(String(providedToken), expectedToken)) {
      return reply.status(401).send({
        error: 'invalid gateway token',
        code: 'GATEWAY_UNAUTHORIZED',
      });
    }

    const query = request.query as Record<string, unknown>;
    const host = normalizeHost(query.host);
    const subdomain = host.split('.')[0];
    if (!subdomain || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain)) {
      return reply.status(422).send({
        error: 'invalid host',
        code: 'GATEWAY_INVALID_HOST',
      });
    }

    const database = await databaseRepo.findOne({ where: { subdomain } });
    if (!database) {
      return reply.status(404).send({
        error: 'database not found',
        code: 'GATEWAY_DATABASE_NOT_FOUND',
      });
    }

    const provider = getRuntimeProvider(database) || (
      resolveEffectiveDatabaseType(database) === 'sqlite' ? 'local-file' : ''
    );
    const upstreamBaseUrl = (() => {
      if (provider === 'docker-libsql') {
        return `http://libsqlite-${database.id}:8080`;
      }
      if (provider === 'sqld-namespace') {
        const internal = normalizeBase(process.env.LIBSQL_INTERNAL_URL || 'http://sqld:8080');
        return `${internal}/dev/${encodeURIComponent(database.subdomain || subdomain)}`;
      }
      if (provider === 'local-file') {
        const backend = normalizeBase(process.env.GATEWAY_BACKEND_INTERNAL_URL || 'http://backend:5000');
        return `${backend}/api/v1/databases/${database.id}`;
      }
      return '';
    })();

    if (!upstreamBaseUrl) {
      return reply.status(409).send({
        error: 'this database type cannot be routed through the gateway',
        code: 'GATEWAY_UNSUPPORTED_PROVIDER',
      });
    }

    reply.header('Cache-Control', 'no-store');
    return reply.send({
      databaseId: database.id,
      subdomain: database.subdomain || subdomain,
      provider,
      upstreamBaseUrl,
      blockReads: Boolean(database.blockReads),
      blockWrites: Boolean(database.blockWrites),
    });
  });

  /**
   * Usage ingest for traffic that never reaches the backend (direct libSQL
   * clients behind the policy gateway). Metrics are best-effort and validated
   * against existing databases so deleted rows cannot re-enter analytics.
   */
  app.post('/internal/gateway/analytics', async (request: FastifyRequest, reply: FastifyReply) => {
    const expectedToken = process.env.GATEWAY_INTERNAL_TOKEN?.trim();
    if (!expectedToken) {
      return reply.status(503).send({
        error: 'gateway analytics is not configured',
        code: 'GATEWAY_ANALYTICS_DISABLED',
      });
    }

    const provided = request.headers['x-gateway-token'];
    const providedToken = Array.isArray(provided) ? provided[0] : provided;
    if (!providedToken || !safeEqual(String(providedToken), expectedToken)) {
      return reply.status(401).send({
        error: 'invalid gateway token',
        code: 'GATEWAY_UNAUTHORIZED',
      });
    }

    const body = parseAndValidate(
      gatewayAnalyticsSchema,
      request.body || {},
      'gateway analytics',
    );
    const queries = body.queries || [];
    const trafficPayload = body.traffic || [];
    const ids = [...new Set([
      ...queries.map((query) => query.databaseId),
      ...trafficPayload
        .map((traffic) => traffic.databaseId)
        .filter((id): id is string => Boolean(id)),
    ])];
    const databases = ids.length > 0
      ? await databaseRepo.find({ where: { id: In(ids) }, relations: ['project'] })
      : [];
    const databaseMap = new Map(databases.map((database) => [database.id, database]));

    let accepted = 0;

    for (const query of queries) {
      const database = databaseMap.get(query.databaseId);
      if (!database) continue;

      analyticsCollector.recordQuery({
        databaseId: database.id,
        projectId: database.project?.id,
        source: 'gateway',
        sql: query.sql,
        durationMs: query.durationMs,
        rowsRead: query.rowsRead || 0,
        rowsWritten: query.rowsWritten || 0,
        success: query.success !== false,
        errorCode: query.errorCode,
      });
      accepted += 1;
    }

    for (const traffic of trafficPayload) {
      if (traffic.databaseId && !databaseMap.has(traffic.databaseId)) continue;

      analyticsCollector.recordTraffic({
        databaseId: traffic.databaseId,
        method: traffic.method,
        path: traffic.path,
        requestBytes: traffic.requestBytes || 0,
        responseBytes: traffic.responseBytes || 0,
        statusCode: traffic.statusCode || 0,
        durationMs: traffic.durationMs || 0,
      });
      accepted += 1;
    }

    reply.header('Cache-Control', 'no-store');
    return reply.status(202).send({ ok: true, accepted });
  });
}

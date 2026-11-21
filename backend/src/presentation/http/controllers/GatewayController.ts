import crypto from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { Database } from '../../../domain/entities/Database';
import { getRuntimeProvider, resolveEffectiveDatabaseType } from '../../../application/databases/database-runtime';

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
}

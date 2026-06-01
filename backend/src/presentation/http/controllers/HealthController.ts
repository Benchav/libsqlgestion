import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { Database } from '../../../domain/entities/Database';

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const runtimeSummary = await summarizeRuntimeHealth().catch(() => null);
    return reply.send({ ok: true, service: 'libsqlite-backend', timestamp: new Date().toISOString(), runtimeSummary });
  });

  app.get('/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!AppDataSource.isInitialized) {
      return reply.code(503).send({ ok: false, reason: 'database not initialized' });
    }

    try {
      await AppDataSource.query('SELECT 1');

      const runtimeSummary = await summarizeRuntimeHealth();
      if (runtimeSummary.unhealthyPublicRuntimeCount > 0) {
        return reply.code(503).send({
          ok: false,
          reason: 'one or more public runtimes are unhealthy',
          runtimeSummary,
        });
      }

      return reply.send({ ok: true, runtimeSummary });
    } catch (error: any) {
      return reply.code(503).send({ ok: false, reason: error.message });
    }
  });
}

async function summarizeRuntimeHealth() {
  if (!AppDataSource.isInitialized) {
    return {
      publicRuntimeCount: 0,
      healthyPublicRuntimeCount: 0,
      unhealthyPublicRuntimeCount: 0,
      provisioningCount: 0,
      errorCount: 0,
    };
  }

  const databases = await AppDataSource.getRepository(Database).find();
  let publicRuntimeCount = 0;
  let healthyPublicRuntimeCount = 0;
  let unhealthyPublicRuntimeCount = 0;
  let provisioningCount = 0;
  let errorCount = 0;

  for (const database of databases) {
    if (database.status === 'provisioning') provisioningCount += 1;
    if (database.status === 'error') errorCount += 1;

    const runtime = database.metadata?.runtime as { provider?: unknown; routeHealth?: Record<string, unknown> } | undefined;
    if (runtime?.provider !== 'docker-libsql') {
      continue;
    }

    publicRuntimeCount += 1;
    const internalOk = Boolean(runtime.routeHealth?.internalOk);
    const backendOk = Boolean(runtime.routeHealth?.backendOk);
    const publicChecked = Boolean(runtime.routeHealth?.publicChecked);
    const publicOk = Boolean(runtime.routeHealth?.publicOk);

    if (internalOk && backendOk && (!publicChecked || publicOk)) {
      healthyPublicRuntimeCount += 1;
    } else {
      unhealthyPublicRuntimeCount += 1;
    }
  }

  return {
    publicRuntimeCount,
    healthyPublicRuntimeCount,
    unhealthyPublicRuntimeCount,
    provisioningCount,
    errorCount,
  };
}

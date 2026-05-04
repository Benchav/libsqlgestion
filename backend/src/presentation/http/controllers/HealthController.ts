import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppDataSource } from '../../../infrastructure/db/data-source';

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ ok: true, service: 'libsqlite-backend', timestamp: new Date().toISOString() });
  });

  app.get('/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!AppDataSource.isInitialized) {
      return reply.code(503).send({ ok: false, reason: 'database not initialized' });
    }

    try {
      await AppDataSource.query('SELECT 1');
      return reply.send({ ok: true });
    } catch (error: any) {
      return reply.code(503).send({ ok: false, reason: error.message });
    }
  });
}

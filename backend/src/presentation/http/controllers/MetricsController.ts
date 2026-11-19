import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SystemMetricsService } from '../../../application/metrics/SystemMetricsService';

export default async function metricsRoutes(app: FastifyInstance) {
  const metricsService = new SystemMetricsService();

  app.get('/metrics', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const force = String((request.query as any)?.fresh || '') === '1';
      const metrics = await metricsService.getMetrics(force);
      return reply.send(metrics);
    } catch (error: any) {
      app.log.error(error);
      return reply.code(500).send({ ok: false, error: 'Failed to retrieve system metrics' });
    }
  });
}

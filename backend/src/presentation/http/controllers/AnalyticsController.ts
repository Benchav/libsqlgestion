import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AnalyticsService } from '../../../application/analytics/AnalyticsService';
import { ensurePermission } from '../guards';
import { analyticsQuerySchema, parseAndValidate } from '../../../types/validations';

export default async function analyticsRoutes(app: FastifyInstance) {
  const analyticsService = new AnalyticsService();

  app.get('/analytics', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'analytics.read'))) return;

    const query = parseAndValidate(analyticsQuerySchema, request.query || {}, 'analytics query');
    try {
      const overview = await analyticsService.getOverview({
        range: query.range,
        from: query.from,
        to: query.to,
      });
      return reply.send(overview);
    } catch (error: any) {
      return reply.status(422).send({ error: error?.message || 'failed to load analytics' });
    }
  });
}

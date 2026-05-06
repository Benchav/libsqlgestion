import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuditService } from '../../../application/audit/AuditService';
import { ensurePermission } from '../guards';

export default async function auditRoutes(app: FastifyInstance) {
  const auditService = new AuditService();

  app.get('/audit', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'audit.read'))) return;

    const query = (request.query as any) || {};
    const page = Number.parseInt(String(query.page || '1'), 10);
    const limit = Number.parseInt(String(query.limit || '50'), 10);
    const search = typeof query.search === 'string' ? query.search : '';

    const result = await auditService.list({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 50,
      search,
    });

    return reply.send(result);
  });
}

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuditService } from '../../../application/audit/AuditService';
import { ensurePermission } from '../guards';
import { auditListQuerySchema, parseAndValidate } from '../../../types/validations';

export default async function auditRoutes(app: FastifyInstance) {
  const auditService = new AuditService();

  app.get('/audit', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'audit.read'))) return;

    const query = parseAndValidate(auditListQuerySchema, request.query || {}, 'audit query');
    const result = await auditService.list({
      page: query.page,
      limit: query.limit,
      search: query.search,
    });

    return reply.send(result);
  });
}

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuditService } from '../../../application/audit/AuditService';
import { ensurePermission } from '../guards';

export default async function auditRoutes(app: FastifyInstance) {
  const auditService = new AuditService();

  app.get('/audit', { preHandler: [app.authenticate as any] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(_request, reply, 'audit.read'))) return;
    const logs = await auditService.list();
    return reply.send({ logs });
  });
}

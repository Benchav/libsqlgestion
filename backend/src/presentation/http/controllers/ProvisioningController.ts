import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProvisioningService } from '../../../application/provisioning/ProvisioningService';
import { ensurePermission, ensureProjectAccess } from '../guards';

export default async function provisioningRoutes(app: FastifyInstance) {
  const provisioningService = new ProvisioningService();

  app.post('/provisioning/sqlite', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = request.body as any;
    if (!body.projectId || !body.name) return reply.status(400).send({ error: 'projectId and name required' });
    const access = await ensureProjectAccess(request, reply, body.projectId);
    if (!access) return;
    const result = await provisioningService.provisionSqlite(body.projectId, body.name, body.subdomain);
    return reply.status(201).send(result);
  });

  app.post('/provisioning/libsql', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = request.body as any;
    if (!body.projectId || !body.name || !body.url || !body.token) return reply.status(400).send({ error: 'projectId, name, url and token required' });
    const access = await ensureProjectAccess(request, reply, body.projectId);
    if (!access) return;
    const result = await provisioningService.provisionLibsql(body.projectId, body);
    return reply.status(201).send(result);
  });
}

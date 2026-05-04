import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DiscoveryService } from '../../../application/databases/DiscoveryService';
import { ensurePermission } from '../guards';

export default async function discoveryRoutes(app: FastifyInstance) {
  const discoveryService = new DiscoveryService();

  app.post('/discovery/sqlite/scan', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = request.body as any;
    if (!body.projectId) return reply.status(400).send({ error: 'projectId required' });
    const result = await discoveryService.scanMountedDirectory(body.projectId, body.rootPath);
    return reply.send(result);
  });
}

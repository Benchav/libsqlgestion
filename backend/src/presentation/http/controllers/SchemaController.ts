import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SchemaService } from '../../../application/databases/SchemaService';
import { ensurePermission, ensureDatabaseAccess } from '../guards';

export default async function schemaRoutes(app: FastifyInstance) {
  const schemaService = new SchemaService();

  app.get('/databases/:id/schema', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    return reply.send(await schemaService.getSchema(id));
  });
}

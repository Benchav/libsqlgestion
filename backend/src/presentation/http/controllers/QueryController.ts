import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { QueryService } from '../../../application/databases/QueryService';
import { ensurePermission } from '../guards';

export default async function queryRoutes(app: FastifyInstance) {
  const queryService = new QueryService();

  app.post('/databases/:id/query', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const body = request.body as any;
    if (!body.sql) return reply.status(400).send({ error: 'sql required' });
    const result = await queryService.execute(id, body.sql, body.params ?? []);
    return reply.send(result);
  });
}

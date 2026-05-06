import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SchemaService } from '../../../application/databases/SchemaService';
import { ensurePermission, ensureDatabaseAccess } from '../guards';
import { DatabaseError } from '../../../infrastructure/sqlite/SqliteClient';

export default async function schemaRoutes(app: FastifyInstance) {
  const schemaService = new SchemaService();

  app.get('/databases/:id/schema', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      return reply.send(await schemaService.getSchema(id));
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        return reply.status(error.recoverable ? 503 : 500).send({
          error: error.message,
          code: error.code,
          tables: [],
          views: [],
        });
      }
      if (error.name === 'EntityNotFoundError') {
        return reply.status(404).send({ error: 'Database not found', tables: [], views: [] });
      }
      return reply.status(500).send({
        error: error.message || 'Failed to retrieve database schema.',
        tables: [],
        views: [],
      });
    }
  });
}

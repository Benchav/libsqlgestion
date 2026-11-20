import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SchemaService } from '../../../application/databases/SchemaService';
import { ensurePermission, ensureDatabaseAccess } from '../guards';
import { DatabaseError } from '../../../infrastructure/sqlite/SqliteClient';
import { DatabaseProtectionError } from '../../../application/databases/database-protection';

export default async function schemaRoutes(app: FastifyInstance) {
  const schemaService = new SchemaService();

  app.get('/databases/:id/schema', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      const query = request.query as any;
      const refresh = String(query?.refresh || '') === '1';
      const counts = String(query?.counts ?? '').toLowerCase();
      const includeRowCounts = !['0', 'false', 'no'].includes(counts);
      return reply.send(await schemaService.getSchema(id, { refresh, includeRowCounts }));
    } catch (error: any) {
      request.log.error({ err: error, databaseId: id }, `[SchemaController] Failed to get schema: ${error?.message || error}`);
      if (error instanceof DatabaseProtectionError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          tables: [],
          views: [],
        });
      }
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

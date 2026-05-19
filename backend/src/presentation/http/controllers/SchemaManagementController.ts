import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensurePermission, ensureDatabaseAccess } from '../guards';
import { SchemaManagementService } from '../../../application/databases/SchemaManagementService';
import { DatabaseError } from '../../../infrastructure/sqlite/SqliteClient';

export default async function schemaManagementRoutes(app: FastifyInstance) {
  const schemaService = new SchemaManagementService();

  app.delete('/databases/:id/schema/tables/:table', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;

    const { id, table } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      const result = await schemaService.deleteTable(id, table, (request as any).user?.sub);
      return reply.send(result);
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        return reply.status(error.code === 'SQLITE_BUSY' ? 503 : 422).send({
          ok: false,
          error: error.message,
          code: error.code,
          recoverable: error.recoverable,
        });
      }

      return reply.status(500).send({ ok: false, error: error.message || 'Failed to delete table' });
    }
  });
}

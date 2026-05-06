import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { QueryService } from '../../../application/databases/QueryService';
import { ensurePermission, ensureDatabaseAccess } from '../guards';
import { DatabaseError } from '../../../infrastructure/sqlite/SqliteClient';

export default async function queryRoutes(app: FastifyInstance) {
  const queryService = new QueryService();

  app.post('/databases/:id/query', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const body = request.body as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    if (!body.sql) return reply.status(400).send({ error: 'sql required' });

    try {
      const result = await queryService.execute(id, body.sql, body.params ?? []);
      return reply.send(result);
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        const statusCode = error.code === 'SQLITE_SYNTAX' || error.code === 'SQLITE_CONSTRAINT' || error.code === 'SQLITE_NO_TABLE' || error.code === 'SQLITE_NO_COLUMN'
          ? 422
          : error.code === 'SQLITE_BUSY'
            ? 503
            : 500;
        return reply.status(statusCode).send({
          ok: false,
          error: error.message,
          code: error.code,
          recoverable: error.recoverable,
        });
      }
      // EntityNotFoundError from TypeORM
      if (error.name === 'EntityNotFoundError') {
        return reply.status(404).send({ ok: false, error: 'Database not found' });
      }
      return reply.status(500).send({
        ok: false,
        error: error.message || 'An unexpected error occurred while executing the query.',
      });
    }
  });
}

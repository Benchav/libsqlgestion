import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MigrationService } from '../../../application/databases/MigrationService';
import { ensurePermission, ensureDatabaseAccess } from '../guards';
import { DatabaseError } from '../../../infrastructure/sqlite/SqliteClient';

export default async function migrationRoutes(app: FastifyInstance) {
  const migrationService = new MigrationService();

  app.get('/databases/:id/migrations', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      return reply.send({ migrations: await migrationService.list(id) });
    } catch (error: any) {
      if (error.name === 'EntityNotFoundError') {
        return reply.status(404).send({ error: 'Database not found', migrations: [] });
      }
      return reply.status(500).send({ error: error.message || 'Failed to list migrations', migrations: [] });
    }
  });

  app.post('/databases/:id/migrations', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const body = request.body as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    if (!body.name || (!body.sql && !body.statements)) return reply.status(400).send({ error: 'name and sql/statements required' });

    try {
      const migration = await migrationService.apply(id, body);
      return reply.status(201).send({ migration });
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        return reply.status(422).send({
          error: error.message,
          code: error.code,
          recoverable: error.recoverable,
        });
      }
      if (error.message?.includes('No SQL statements')) {
        return reply.status(400).send({ error: error.message });
      }
      return reply.status(422).send({
        error: error.message || 'Migration failed',
      });
    }
  });
}

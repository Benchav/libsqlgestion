import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MigrationService } from '../../../application/databases/MigrationService';
import { ensurePermission, ensureDatabaseAccess } from '../guards';

export default async function migrationRoutes(app: FastifyInstance) {
  const migrationService = new MigrationService();

  app.get('/databases/:id/migrations', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    return reply.send({ migrations: await migrationService.list(id) });
  });

  app.post('/databases/:id/migrations', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const body = request.body as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    if (!body.name || (!body.sql && !body.statements)) return reply.status(400).send({ error: 'name and sql/statements required' });
    const migration = await migrationService.apply(id, body);
    return reply.status(201).send({ migration });
  });
}

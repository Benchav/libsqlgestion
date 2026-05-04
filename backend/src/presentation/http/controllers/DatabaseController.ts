import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DatabaseService } from '../../../application/databases/DatabaseService';
import { ensurePermission } from '../guards';

export default async function databaseRoutes(app: FastifyInstance) {
  const databaseService = new DatabaseService();

  app.get('/databases', { preHandler: [app.authenticate as any] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(_request, reply, 'databases.read'))) return;
    const databases = await databaseService.listDatabases();
    return reply.send({ databases });
  });

  app.post('/databases', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = request.body as any;
    if (!body.projectId || !body.name || !body.type) return reply.status(400).send({ error: 'projectId, name and type required' });
    const result = await databaseService.createDatabase(body.projectId, body);
    return reply.status(201).send({ database: result.database, token: result.token });
  });

  app.post('/databases/import-sqlite', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = request.body as any;
    if (!body.projectId || !body.name || !body.sourcePath) return reply.status(400).send({ error: 'projectId, name and sourcePath required' });
    const result = await databaseService.importExistingSqlite(body.projectId, body);
    return reply.status(201).send(result);
  });

  app.get('/databases/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const database = await databaseService.getDatabase(id);
    if (!database) return reply.status(404).send({ error: 'database not found' });
    return reply.send({ database });
  });

  app.patch('/databases/:id/rotate-token', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const result = await databaseService.rotateToken(id);
    return reply.send({ database: result.database, token: result.token });
  });

  app.post('/databases/:id/test-connection', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const result = await databaseService.testConnection(id);
    return reply.send(result);
  });
}

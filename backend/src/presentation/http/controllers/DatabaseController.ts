import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DatabaseService } from '../../../application/databases/DatabaseService';
import { ensurePermission, ensureDatabaseAccess, ensureProjectAccess } from '../guards';

export default async function databaseRoutes(app: FastifyInstance) {
  const databaseService = new DatabaseService();

  app.get('/databases', { preHandler: [app.authenticate as any] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(_request, reply, 'databases.read'))) return;
    const query = (_request.query as any) || {};
    const databases = await databaseService.listDatabases(query.projectId);
    return reply.send({ databases });
  });

  app.post('/databases', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = request.body as any;
    if (!body.projectId || !body.name || !body.type) return reply.status(400).send({ error: 'projectId, name and type required' });
    if (typeof body.projectId !== 'string' || typeof body.name !== 'string' || typeof body.type !== 'string') return reply.status(400).send({ error: 'invalid payload' });
    if (!['sqlite', 'libsql', 'remote'].includes(body.type)) return reply.status(400).send({ error: 'invalid database type' });
    const result = await databaseService.createDatabase(body.projectId, body);
    return reply.status(201).send({ database: result.database, token: result.token });
  });

  app.post('/databases/import-sqlite', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = request.body as any;
    if (!body.projectId || !body.name || !body.sourcePath) return reply.status(400).send({ error: 'projectId, name and sourcePath required' });
    if (typeof body.projectId !== 'string' || typeof body.name !== 'string' || typeof body.sourcePath !== 'string') return reply.status(400).send({ error: 'invalid payload' });
    const result = await databaseService.importExistingSqlite(body.projectId, body);
    return reply.status(201).send(result);
  });

  app.get('/databases/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    const database = await databaseService.getDatabase(id);
    if (!database) return reply.status(404).send({ error: 'database not found' });
    return reply.send({ database });
  });

  app.patch('/databases/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const body = request.body as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    try {
      const database = await databaseService.updateDatabase(id, body);
      return reply.send({ database });
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  app.delete('/databases/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    try {
      const result = await databaseService.deleteDatabase(id);
      return reply.send(result);
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  app.patch('/databases/:id/rotate-token', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    const result = await databaseService.rotateToken(id);
    return reply.send({ database: result.database, token: result.token });
  });

  app.post('/databases/:id/test-connection', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    const result = await databaseService.testConnection(id);
    return reply.send(result);
  });
}

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { DatabaseService } from '../../../application/databases/DatabaseService';
import { buildDatabaseConnectionUrls } from '../../../application/databases/connection-url';
import { ensurePermission, ensureDatabaseAccess, ensureProjectAccess } from '../guards';

function withConnectionUrl<T extends { id: string; name: string; type: string; url?: string; subdomain?: string }>(database: T) {
  const urls = buildDatabaseConnectionUrls(database);
  return {
    ...database,
    connectionUrl: urls.publicUrl,
    publicConnectionUrl: urls.publicUrl,
    internalConnectionUrl: urls.internalUrl,
  };
}

export default async function databaseRoutes(app: FastifyInstance) {
  const databaseService = new DatabaseService();

  app.get('/databases', { preHandler: [app.authenticate as any] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(_request, reply, 'databases.read'))) return;
    const query = (_request.query as any) || {};
    const databases = await databaseService.listDatabases(query.projectId);
    return reply.send({ databases: databases.map((database) => withConnectionUrl(database)) });
  });

  app.post('/databases', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = request.body as any;
    if (!body.projectId || !body.name || !body.type) return reply.status(400).send({ error: 'projectId, name and type required' });
    if (typeof body.projectId !== 'string' || typeof body.name !== 'string' || typeof body.type !== 'string') return reply.status(400).send({ error: 'invalid payload' });
    if (!['sqlite', 'libsql', 'remote'].includes(body.type)) return reply.status(400).send({ error: 'invalid database type' });
    try {
      const result = await databaseService.createDatabase(body.projectId, body);
      return reply.status(201).send({ database: withConnectionUrl(result.database), token: result.token });
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'failed to create database' });
    }
  });

  app.post('/databases/import-sqlite', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = request.body as any;
    if (!body.projectId || !body.sourcePath) return reply.status(400).send({ error: 'projectId and sourcePath required' });
    if (typeof body.projectId !== 'string' || typeof body.sourcePath !== 'string') return reply.status(400).send({ error: 'invalid payload' });
    try {
      const result = await databaseService.importExistingSqlite(body.projectId, body);
      return reply.status(201).send({ ...result, database: withConnectionUrl(result.database) });
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'failed to import database' });
    }
  });

  app.post('/databases/import-upload', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;

    const fields: Record<string, string> = {};
    let uploadedPath = '';
    let uploadedFileName = '';

    for await (const part of request.parts() as any) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') {
          part.file.resume();
          continue;
        }

        const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'libsqlite-upload-'));
        uploadedFileName = part.filename || 'database.db';
        uploadedPath = path.join(tempRoot, uploadedFileName);
        await pipeline(part.file, fs.createWriteStream(uploadedPath));
        continue;
      }

      if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }

    if (!fields.projectId || !uploadedPath) {
      return reply.status(400).send({ error: 'projectId and file required' });
    }

    const access = await ensureProjectAccess(request, reply, fields.projectId);
    if (!access) return;

    try {
      const result = await databaseService.importExistingSqlite(fields.projectId, {
        name: fields.name,
        sourceName: uploadedFileName,
        sourcePath: uploadedPath,
        subdomain: fields.subdomain || undefined,
      });
      return reply.status(201).send({ ...result, database: withConnectionUrl(result.database) });
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'failed to import uploaded database' });
    } finally {
      if (uploadedPath) {
        const tempDir = path.dirname(uploadedPath);
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  app.get('/databases/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    const database = await databaseService.getDatabase(id);
    if (!database) return reply.status(404).send({ error: 'database not found' });
    return reply.send({ database: withConnectionUrl(database) });
  });

  app.patch('/databases/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const body = request.body as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    try {
      const database = await databaseService.updateDatabase(id, body);
      return reply.send({ database: withConnectionUrl(database) });
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
    return reply.send({ database: withConnectionUrl(result.database), token: result.token });
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

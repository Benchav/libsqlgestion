import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { DatabaseService } from '../../../application/databases/DatabaseService';
import { buildDatabaseConnectionUrls } from '../../../application/databases/connection-url';
import { ensurePermission, ensureDatabaseAccess, ensureProjectAccess } from '../guards';
import { parseAndValidate, createDatabaseSchema, importSqliteSchema, updateDatabaseSchema, backupDatabaseSchema, pageQuerySchema } from '../../../types/validations';
import { ValidationError } from '../../../types/validations';

function withConnectionUrl<T extends { id: string; name: string; type: string; url?: string | null; subdomain?: string | null }>(database: T) {
  const urls = buildDatabaseConnectionUrls(database);
  const runtime = (database as any).metadata?.runtime as { provider?: unknown } | undefined;
  const runtimeStatus = typeof (database as any).status === 'string' ? (database as any).status : 'inactive';
  return {
    ...database,
    connectionUrl: urls.publicHttpsUrl || urls.publicLibsqlUrl || urls.backendUrl,
    publicConnectionUrl: urls.publicHttpsUrl,
    publicHttpsUrl: urls.publicHttpsUrl,
    publicLibsqlUrl: urls.publicLibsqlUrl,
    internalConnectionUrl: urls.internalUrl,
    internalLibsqlUrl: urls.internalUrl,
    backendConnectionUrl: urls.backendUrl,
    backendReachableUrl: urls.backendUrl,
    runtimeStatus,
    exposureMode: runtime?.provider === 'docker-libsql' ? 'public-runtime' : runtime?.provider === 'local-file' ? 'local-file' : database.type,
    runtimeHealth: (database as any).metadata?.runtime?.routeHealth,
  };
}

export default async function databaseRoutes(app: FastifyInstance) {
  const databaseService = new DatabaseService();

  app.get('/databases', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    try {
      const query = parseAndValidate(pageQuerySchema, request.query || {}, 'query');
      const databases = await databaseService.listDatabases((request.query as any)?.projectId);
      const enriched = databases.map((db) => withConnectionUrl(db));

      if (query.page && query.limit) {
        const start = (query.page - 1) * query.limit;
        const page = enriched.slice(start, start + query.limit);
        return reply.send({
          databases: page,
          total: enriched.length,
          page: query.page,
          limit: query.limit,
          hasMore: start + query.limit < enriched.length,
        });
      }

      return reply.send({ databases: enriched });
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      return reply.status(500).send({ error: 'failed to list databases' });
    }
  });

  app.post('/databases', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = parseAndValidate(createDatabaseSchema, request.body, 'create database');
    try {
      const result = await databaseService.createDatabase(body.projectId, body);
      return reply.status(201).send({ database: withConnectionUrl(result.database), token: result.token });
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'failed to create database' });
    }
  });

  app.post('/databases/import-sqlite', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = parseAndValidate(importSqliteSchema, request.body, 'import sqlite');
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
    const body = parseAndValidate(updateDatabaseSchema, request.body, 'update database');
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

  app.get('/databases/:id/download', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    const { id } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    try {
      const database = await databaseService.getDatabase(id);
      if (!database) return reply.status(404).send({ error: 'database not found' });
      
      const filePath = await databaseService.getDatabaseFilePath(id);
      if (!fs.existsSync(filePath)) {
        return reply.status(404).send({ error: 'database file not found on disk' });
      }

      const filename = `${database.name}.db`;
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.header('Content-Type', 'application/x-sqlite3');

      const stream = fs.createReadStream(filePath);
      return reply.send(stream);
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'failed to download database file' });
    }
  });

  app.post('/databases/:id/backup', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const body = parseAndValidate(backupDatabaseSchema, request.body, 'backup database');
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    try {
      const result = await databaseService.backupDatabase(id, { name: body.name });
      return reply.status(201).send({ database: withConnectionUrl(result.database), token: result.token });
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'failed to create backup' });
    }
  });
}

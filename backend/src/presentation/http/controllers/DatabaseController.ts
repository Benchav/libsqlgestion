import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { DatabaseService } from '../../../application/databases/DatabaseService';
import { ensurePermission, ensureDatabaseAccess, ensureProjectAccess } from '../guards';
import { parseAndValidate, createDatabaseSchema, importSqliteSchema, updateDatabaseSchema, backupDatabaseSchema, pageQuerySchema } from '../../../types/validations';
import { ValidationError } from '../../../types/validations';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { Database } from '../../../domain/entities/Database';
import { decrypt } from '../../../infrastructure/crypto';
import { ConnectionPool } from '../../../infrastructure/db/ConnectionPool';
import { SqliteClient } from '../../../infrastructure/sqlite/SqliteClient';
import { LibsqlNamespaceService } from '../../../infrastructure/libsql/LibsqlNamespaceService';
import { presentDatabase } from '../database-presenter';

function formatHranaValue(val: any) {
  if (val === null || val === undefined) return { type: 'null' };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { type: 'integer', value: String(val) };
    return { type: 'float', value: val };
  }
  if (typeof val === 'bigint') {
    return { type: 'integer', value: String(val) };
  }
  if (Buffer.isBuffer(val)) {
    return { type: 'blob', base64: val.toString('base64') };
  }
  return { type: 'text', value: String(val) };
}

export default async function databaseRoutes(app: FastifyInstance) {
  const databaseService = new DatabaseService();

  app.get('/databases', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.read'))) return;
    try {
      const query = parseAndValidate(pageQuerySchema, request.query || {}, 'query');
      const databases = await databaseService.listDatabases((request.query as any)?.projectId);
      const enriched = databases.map((db) => presentDatabase(db));

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
      return reply.status(201).send({ database: presentDatabase(result.database), token: result.token });
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'failed to create database' });
    }
  });

  app.post('/databases/import-sqlite', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const body = parseAndValidate(importSqliteSchema, request.body, 'import sqlite');
    try {
      const result = await databaseService.importExistingSqlite(body.projectId, body);
      return reply.status(201).send({ ...result, database: presentDatabase(result.database) });
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
      return reply.status(201).send({ ...result, database: presentDatabase(result.database) });
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
    return reply.send({ database: presentDatabase(database) });
  });

  app.patch('/databases/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const body = parseAndValidate(updateDatabaseSchema, request.body, 'update database');
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;
    try {
      const database = await databaseService.updateDatabase(id, body);
      return reply.send({ database: presentDatabase(database) });
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
    return reply.send({ database: presentDatabase(result.database), token: result.token });
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
      return reply.status(201).send({ database: presentDatabase(result.database), token: result.token });
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'failed to create backup' });
    }
  });

  // ---------------------------------------------------------------------------
  // Turso-compatible LibSQL Hrana Pipeline Endpoint (/v2/pipeline, /v1/pipeline)
  // Allows any external @libsql/client to connect via URL and Auth Token
  // ---------------------------------------------------------------------------
  function parseHranaValue(a: any): any {
    if (a === null || a === undefined) return null;
    if (typeof a !== 'object') return a;
    if (a.type === 'null') return null;
    if (a.type === 'integer') {
      const num = Number(a.value);
      return Number.isSafeInteger(num) ? num : a.value;
    }
    if (a.type === 'float') return Number(a.value);
    if (a.type === 'text') return String(a.value);
    if (a.type === 'blob') return Buffer.from(a.base64 || '', 'base64');
    if ('value' in a) return parseHranaValue(a.value);
    return a;
  }

  function evalBatchCond(cond: any, stepResults: any[], stepErrors: any[]): boolean {
    if (!cond) return true;
    if (cond.type === 'ok') {
      const stepIdx = cond.step;
      return stepResults[stepIdx] !== null && stepResults[stepIdx] !== undefined;
    }
    if (cond.type === 'error') {
      const stepIdx = cond.step;
      return stepErrors[stepIdx] !== null && stepErrors[stepIdx] !== undefined;
    }
    if (cond.type === 'not') {
      return !evalBatchCond(cond.cond, stepResults, stepErrors);
    }
    if (cond.type === 'and') {
      return (cond.conds || []).every((c: any) => evalBatchCond(c, stepResults, stepErrors));
    }
    if (cond.type === 'or') {
      return (cond.conds || []).some((c: any) => evalBatchCond(c, stepResults, stepErrors));
    }
    if (cond.type === 'is_autocommit') {
      return true;
    }
    return true;
  }

  async function executeHranaStmt(client: any, stmt: any, sqlMap?: Map<number, string>) {
    const sql = stmt?.sql || (stmt?.sql_id != null && sqlMap ? sqlMap.get(stmt.sql_id) : undefined);
    if (!sql) throw new Error('missing sql statement');

    let args: any[] = [];
    if (Array.isArray(stmt.args)) {
      args = stmt.args.map(parseHranaValue);
    } else if (Array.isArray(stmt.named_args)) {
      const named: Record<string, any> = {};
      for (const na of stmt.named_args) {
        if (na && na.name) {
          named[na.name] = parseHranaValue(na.value);
        }
      }
      args = [named];
    }

    if (client instanceof SqliteClient) {
      const isSelect = /^\s*(WITH\b[\s\S]*?\bSELECT|SELECT|PRAGMA|EXPLAIN)\b/i.test(sql);
      if (isSelect) {
        const rows = await client.all(sql, args);
        const cols = rows.length > 0 ? Object.keys(rows[0] as object).map((k) => ({ name: k })) : [];
        const hranaRows = rows.map((row: any) => Object.values(row).map(formatHranaValue));
        return {
          cols,
          rows: hranaRows,
          affected_row_count: 0,
          last_insert_rowid: null,
        };
      } else {
        const runRes = await client.run(sql, args);
        return {
          cols: [],
          rows: [],
          affected_row_count: runRes.changes || 0,
          last_insert_rowid: runRes.lastID != null ? String(runRes.lastID) : null,
        };
      }
    } else {
      const res = await (client as any).execute({ sql, args });
      const cols = (res.columns || []).map((col: string) => ({ name: col }));
      const hranaRows = (res.rows || []).map((row: any) => Object.values(row).map(formatHranaValue));
      return {
        cols,
        rows: hranaRows,
        affected_row_count: res.rowsAffected || 0,
        last_insert_rowid: res.lastInsertRowid != null ? String(res.lastInsertRowid) : null,
      };
    }
  }

  const handlePipeline = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = (request.params || {}) as any;
    const query = (request.query || {}) as any;
    const targetIdentifier = params.id || query.databaseId || request.headers['x-database-id'];

    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!token) {
      return reply.code(401).send({ error: 'unauthorized: missing database authorization token' });
    }

    let database: Database | null = null;
    if (targetIdentifier) {
      database = await AppDataSource.getRepository(Database).findOne({
        where: [{ id: targetIdentifier }, { subdomain: targetIdentifier }],
        relations: ['project'],
      });
    }

    // If identifier was not provided or not found, identify database by token
    if (!database) {
      try {
        const namespaceService = new LibsqlNamespaceService();
        const payload = namespaceService.verifyToken(token);
        if (payload && payload.ns) {
          database = await AppDataSource.getRepository(Database).findOne({
            where: { subdomain: payload.ns },
            relations: ['project'],
          });
        }
      } catch {}

      if (!database) {
        const allDbs = await AppDataSource.getRepository(Database).find({ relations: ['project'] });
        for (const db of allDbs) {
          if (db.encryptedToken) {
            try {
              if (decrypt(db.encryptedToken) === token) {
                database = db;
                break;
              }
            } catch {}
          }
        }
      }
    }

    if (!database) {
      return reply.code(404).send({ error: 'database not found' });
    }

    // Authenticate database token
    let tokenValid = false;
    if (database.encryptedToken) {
      try {
        const expectedToken = decrypt(database.encryptedToken);
        if (token === expectedToken) {
          tokenValid = true;
        }
      } catch {}
    }

    if (!tokenValid && database.subdomain) {
      try {
        const namespaceService = new LibsqlNamespaceService();
        const payload = namespaceService.verifyToken(token);
        if (payload && payload.ns === database.subdomain) {
          tokenValid = true;
        }
      } catch {}
    }

    if (!tokenValid) {
      return reply.code(401).send({ error: 'unauthorized: invalid database token' });
    }

    const body = (request.body || {}) as { requests?: any[] };
    const requests = Array.isArray(body.requests) ? body.requests : [];
    const results: any[] = [];
    const sqlMap = new Map<number, string>();

    const client = ConnectionPool.getInstance().getClient(database);

    for (const reqItem of requests) {
      if (reqItem.type === 'store_sql') {
        if (reqItem.sql_id != null && reqItem.sql) {
          sqlMap.set(reqItem.sql_id, reqItem.sql);
        }
        results.push({ type: 'ok', response: { type: 'store_sql' } });
      } else if (reqItem.type === 'close_sql') {
        if (reqItem.sql_id != null) {
          sqlMap.delete(reqItem.sql_id);
        }
        results.push({ type: 'ok', response: { type: 'close_sql' } });
      } else if (reqItem.type === 'execute') {
        try {
          const stmtResult = await executeHranaStmt(client, reqItem.stmt, sqlMap);
          results.push({
            type: 'ok',
            response: {
              type: 'execute',
              result: stmtResult,
            },
          });
        } catch (err: any) {
          results.push({
            type: 'error',
            error: {
              message: err?.message || 'execution error',
              code: 'SQLITE_ERROR',
            },
          });
        }
      } else if (reqItem.type === 'batch') {
        const stepResults: any[] = [];
        const stepErrors: any[] = [];
        const steps = reqItem.batch?.steps || [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const shouldRun = evalBatchCond(step.condition, stepResults, stepErrors);
          if (!shouldRun) {
            stepResults.push(null);
            stepErrors.push(null);
            continue;
          }

          try {
            const stmtResult = await executeHranaStmt(client, step.stmt, sqlMap);
            stepResults.push(stmtResult);
            stepErrors.push(null);
          } catch (err: any) {
            stepResults.push(null);
            stepErrors.push({
              message: err?.message || 'batch step error',
              code: 'SQLITE_ERROR',
            });
          }
        }
        results.push({
          type: 'ok',
          response: {
            type: 'batch',
            result: {
              step_results: stepResults,
              step_errors: stepErrors,
            },
          },
        });
      } else if (reqItem.type === 'sequence') {
        try {
          if (reqItem.sql) {
            if (client instanceof SqliteClient) {
              await client.exec(reqItem.sql);
            } else {
              await (client as any).execute(reqItem.sql);
            }
          }
          results.push({ type: 'ok', response: { type: 'sequence' } });
        } catch (err: any) {
          results.push({
            type: 'error',
            error: {
              message: err?.message || 'sequence error',
              code: 'SQLITE_ERROR',
            },
          });
        }
      } else if (reqItem.type === 'close') {
        results.push({ type: 'ok', response: { type: 'close' } });
      } else {
        results.push({ type: 'ok', response: { type: reqItem.type } });
      }
    }

    return reply.send({
      baton: null,
      base_url: null,
      results,
    });
  };

  const handleVersion = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ version: 2 });
  };

  app.post('/databases/:id/v2/pipeline', handlePipeline);
  app.post('/databases/:id/v1/pipeline', handlePipeline);
  app.post('/databases/:id/pipeline', handlePipeline);
  app.post('/databases/v2/pipeline', handlePipeline);
  app.post('/databases/v1/pipeline', handlePipeline);
  app.post('/databases/pipeline', handlePipeline);

  app.get('/databases/:id/v2', handleVersion);
  app.get('/databases/:id/v1', handleVersion);
  app.get('/databases/v2', handleVersion);
  app.get('/databases/v1', handleVersion);
}

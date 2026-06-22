import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConnectionPool } from '../../../infrastructure/db/ConnectionPool';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { Database } from '../../../domain/entities/Database';
import { decrypt } from '../../../infrastructure/crypto';
import { DatabaseError } from '../../../infrastructure/sqlite/SqliteClient';

interface LibSqlValue {
  type: string;
  value?: string | number;
  base64?: string;
}

interface LibSqlStmt {
  sql: string;
  args?: LibSqlValue[];
  named_args?: { name: string; value: LibSqlValue }[];
}

interface LibSqlRequest {
  type: string;
  stmt?: LibSqlStmt;
}

export default async function libsqlProxyRoutes(app: FastifyInstance) {
  const databaseRepo = AppDataSource.getRepository(Database);

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as any;
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }
    const token = authHeader.split(' ')[1];

    const database = await databaseRepo.findOne({ where: { id } });
    if (!database) {
      return reply.status(404).send({ error: 'Database not found' });
    }

    if (!database.encryptedToken) {
      return reply.status(401).send({ error: 'Database has no access token configured' });
    }

    const validToken = decrypt(database.encryptedToken);
    if (token !== validToken) {
      return reply.status(401).send({ error: 'Invalid token' });
    }

    if (database.type !== 'sqlite') {
      return reply.status(400).send({ error: 'This endpoint only proxies local SQLite databases' });
    }

    const body = request.body as any;
    if (!body || !Array.isArray(body.requests)) {
      return reply.status(400).send({ error: 'Invalid libSQL pipeline payload' });
    }

    const pool = ConnectionPool.getInstance();
    let client: any;
    try {
      client = pool.getSqliteClient(database);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }

    const results = [];

    // Begin a transaction if the pipeline has multiple execute requests, 
    // to mimic hrana's batch behavior if needed, though pipeline requests are independent.
    // We will just execute them sequentially.
    for (const req of body.requests as LibSqlRequest[]) {
      if (req.type === 'close') {
        results.push({ type: 'ok', response: { type: 'close' } });
        continue;
      }

      if (req.type === 'execute' && req.stmt) {
        try {
          const sql = req.stmt.sql;
          let params: any = [];

          if (req.stmt.named_args && req.stmt.named_args.length > 0) {
            params = {};
            for (const arg of req.stmt.named_args) {
              const val = mapLibSqlValueToJs(arg.value);
              if (/^[:$@]/.test(arg.name)) {
                params[arg.name] = val;
              } else {
                params[`:${arg.name}`] = val;
                params[`$${arg.name}`] = val;
                params[`@${arg.name}`] = val;
              }
            }
          } else if (req.stmt.args && req.stmt.args.length > 0) {
            params = req.stmt.args.map(mapLibSqlValueToJs);
          }

          const isWrite = /^\s*(insert|update|delete|create|drop|alter|replace)\b/i.test(sql);
          let rawRows: any[] = [];
          let changes = 0;
          let lastInsertRowid = 0;

          if (isWrite) {
            const runResult = await client.run(sql, params);
            changes = runResult.changes;
            lastInsertRowid = runResult.lastID;
          } else {
            rawRows = await client.all(sql, params);
          }

          results.push({
            type: 'ok',
            response: {
              type: 'execute',
              result: mapJsRowsToLibSqlResult(rawRows, changes, lastInsertRowid)
            }
          });
        } catch (error: any) {
          const message = error instanceof DatabaseError ? error.message : String(error.message || error);
          const code = error instanceof DatabaseError ? error.code : 'SQLITE_ERROR';
          results.push({
            type: 'error',
            error: { message, code }
          });
        }
        continue;
      }

      // Unsupported request type
      results.push({
        type: 'error',
        error: { message: `Unsupported request type: ${req.type}` }
      });
    }

    return reply.send({
      baton: null,
      baseUrl: `http://${request.headers.host}`,
      results
    });
  };

  app.post('/api/v1/libsql/:id/v2/pipeline', handler);
  app.post('/libsql/:id/v2/pipeline', handler);
}

function mapLibSqlValueToJs(val: LibSqlValue): any {
  if (val.type === 'null') return null;
  if (val.type === 'integer' || val.type === 'float') return Number(val.value);
  if (val.type === 'text') return String(val.value);
  if (val.type === 'blob') {
    if (val.base64) return Buffer.from(val.base64, 'base64');
    return Buffer.from(String(val.value), 'base64');
  }
  return val.value;
}

function mapJsRowsToLibSqlResult(rows: any[], changes: number, lastID: number) {
  let cols: { name: string; decltype: string }[] = [];
  if (rows.length > 0) {
    cols = Object.keys(rows[0]).map(k => ({ name: k, decltype: '' }));
  }

  const libsqlRows = rows.map(row => {
    return cols.map(col => {
      const val = row[col.name];
      if (val === null || val === undefined) return { type: 'null' };
      if (typeof val === 'number') {
        return Number.isInteger(val) ? { type: 'integer', value: String(val) } : { type: 'float', value: val };
      }
      if (typeof val === 'string') return { type: 'text', value: val };
      if (Buffer.isBuffer(val)) return { type: 'blob', base64: val.toString('base64') };
      if (typeof val === 'boolean') return { type: 'integer', value: val ? '1' : '0' };
      return { type: 'text', value: String(val) };
    });
  });

  return {
    cols,
    rows: libsqlRows,
    affected_row_count: changes,
    last_insert_rowid: String(lastID || 0)
  };
}

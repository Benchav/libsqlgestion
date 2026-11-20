import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { QueryService } from '../../../application/databases/QueryService';
import { ensurePermission, ensureDatabaseAccess } from '../guards';
import { DatabaseError } from '../../../infrastructure/sqlite/SqliteClient';
import { DatabaseProtectionError } from '../../../application/databases/database-protection';
import { executeQuerySchema, parseAndValidate } from '../../../types/validations';
import { analyticsCollector } from '../../../application/analytics/AnalyticsCollector';

export default async function queryRoutes(app: FastifyInstance) {
  const queryService = new QueryService();

  app.post('/databases/:id/query', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;
    const { id } = request.params as any;
    const body = parseAndValidate(executeQuerySchema, request.body, 'query');
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    const startedAt = Date.now();
    try {
      const result = await queryService.execute(id, body.sql, body.params, {
        limit: body.limit,
        offset: body.offset,
        countTotal: body.countTotal,
      });

      analyticsCollector.recordQuery({
        databaseId: id,
        projectId: access.project?.id,
        source: body.source || 'api',
        sql: body.sql,
        durationMs: result.durationMs ?? Date.now() - startedAt,
        rowsRead: result.rowsReturned ?? result.rows?.length ?? 0,
        rowsWritten: result.rowsAffected ?? result.result?.changes ?? 0,
        success: result.ok !== false,
      });

      return reply.send(result);
    } catch (error: any) {
      analyticsCollector.recordQuery({
        databaseId: id,
        projectId: access.project?.id,
        source: body.source || 'api',
        sql: body.sql,
        durationMs: Date.now() - startedAt,
        success: false,
        errorCode: error?.code || 'QUERY_ERROR',
      });

      if (error instanceof DatabaseProtectionError) {
        return reply.status(error.statusCode).send({
          ok: false,
          error: error.message,
          code: error.code,
        });
      }
      if (error instanceof DatabaseError) {
        const statusCode = error.code === 'SQLITE_SYNTAX' || error.code === 'SQLITE_CONSTRAINT' || error.code === 'SQLITE_NO_TABLE' || error.code === 'SQLITE_NO_COLUMN'
          ? 422
          : error.code === 'SQLITE_TIMEOUT'
            ? 504
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

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensurePermission, ensureDatabaseAccess } from '../guards';
import { SchemaManagementService } from '../../../application/databases/SchemaManagementService';
import { DatabaseError } from '../../../infrastructure/sqlite/SqliteClient';

export default async function schemaManagementRoutes(app: FastifyInstance) {
  const schemaService = new SchemaManagementService();

  app.delete('/databases/:id/schema/tables/:table', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;

    const { id, table } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      const result = await schemaService.deleteTable(id, table, (request as any).user?.sub);
      return reply.send(result);
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        return reply.status(error.code === 'SQLITE_BUSY' ? 503 : 422).send({
          ok: false,
          error: error.message,
          code: error.code,
          recoverable: error.recoverable,
        });
      }

      return reply.status(500).send({ ok: false, error: error.message || 'Failed to delete table' });
    }
  });

  app.patch('/databases/:id/schema/tables/:table/rename', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;

    const { id, table } = request.params as any;
    const body = (request.body as any) || {};
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    if (typeof body.name !== 'string' || !body.name.trim()) {
      return reply.status(400).send({ ok: false, error: 'name is required' });
    }

    try {
      const result = await schemaService.renameTable(id, table, body.name.trim(), (request as any).user?.sub);
      return reply.send(result);
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        return reply.status(error.code === 'SQLITE_BUSY' ? 503 : 422).send({
          ok: false,
          error: error.message,
          code: error.code,
          recoverable: error.recoverable,
        });
      }

      return reply.status(500).send({ ok: false, error: error.message || 'Failed to rename table' });
    }
  });

  app.post('/databases/:id/schema/tables/:table/columns', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;

    const { id, table } = request.params as any;
    const body = (request.body as any) || {};
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      const result = await schemaService.addColumn(id, table, body, (request as any).user?.sub);
      return reply.status(201).send(result);
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        return reply.status(error.code === 'SQLITE_BUSY' ? 503 : 422).send({
          ok: false,
          error: error.message,
          code: error.code,
          recoverable: error.recoverable,
        });
      }

      return reply.status(500).send({ ok: false, error: error.message || 'Failed to add column' });
    }
  });

  app.patch('/databases/:id/schema/tables/:table/columns/:column/rename', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;

    const { id, table, column } = request.params as any;
    const body = (request.body as any) || {};
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    if (typeof body.name !== 'string' || !body.name.trim()) {
      return reply.status(400).send({ ok: false, error: 'name is required' });
    }

    try {
      const result = await schemaService.renameColumn(id, table, column, body.name.trim(), (request as any).user?.sub);
      return reply.send(result);
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        return reply.status(error.code === 'SQLITE_BUSY' ? 503 : 422).send({
          ok: false,
          error: error.message,
          code: error.code,
          recoverable: error.recoverable,
        });
      }

      return reply.status(500).send({ ok: false, error: error.message || 'Failed to rename column' });
    }
  });

  app.patch('/databases/:id/schema/tables/:table/columns/:column/type', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;

    const { id, table, column } = request.params as any;
    const body = (request.body as any) || {};
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    if (typeof body.type !== 'string' || !body.type.trim()) {
      return reply.status(400).send({ ok: false, error: 'type is required' });
    }

    try {
      const result = await schemaService.changeColumnType(id, table, column, body.type.trim(), (request as any).user?.sub);
      return reply.send(result);
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        return reply.status(error.code === 'SQLITE_BUSY' ? 503 : 422).send({
          ok: false,
          error: error.message,
          code: error.code,
          recoverable: error.recoverable,
        });
      }

      return reply.status(500).send({ ok: false, error: error.message || 'Failed to change column type' });
    }
  });

  app.delete('/databases/:id/schema/tables/:table/columns/:column', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'databases.write'))) return;

    const { id, table, column } = request.params as any;
    const access = await ensureDatabaseAccess(request, reply, id);
    if (!access) return;

    try {
      const result = await schemaService.deleteColumn(id, table, column, (request as any).user?.sub);
      return reply.send(result);
    } catch (error: any) {
      if (error instanceof DatabaseError) {
        return reply.status(error.code === 'SQLITE_BUSY' ? 503 : 422).send({
          ok: false,
          error: error.message,
          code: error.code,
          recoverable: error.recoverable,
        });
      }

      return reply.status(500).send({ ok: false, error: error.message || 'Failed to delete column' });
    }
  });
}

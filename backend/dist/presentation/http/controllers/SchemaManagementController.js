"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = schemaManagementRoutes;
const guards_1 = require("../guards");
const SchemaManagementService_1 = require("../../../application/databases/SchemaManagementService");
const SqliteClient_1 = require("../../../infrastructure/sqlite/SqliteClient");
async function schemaManagementRoutes(app) {
    const schemaService = new SchemaManagementService_1.SchemaManagementService();
    app.delete('/databases/:id/schema/tables/:table', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id, table } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const result = await schemaService.deleteTable(id, table, request.user?.sub);
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof SqliteClient_1.DatabaseError) {
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
    app.patch('/databases/:id/schema/tables/:table/rename', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id, table } = request.params;
        const body = request.body || {};
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        if (typeof body.name !== 'string' || !body.name.trim()) {
            return reply.status(400).send({ ok: false, error: 'name is required' });
        }
        try {
            const result = await schemaService.renameTable(id, table, body.name.trim(), request.user?.sub);
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof SqliteClient_1.DatabaseError) {
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
    app.post('/databases/:id/schema/tables/:table/columns', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id, table } = request.params;
        const body = request.body || {};
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const result = await schemaService.addColumn(id, table, body, request.user?.sub);
            return reply.status(201).send(result);
        }
        catch (error) {
            if (error instanceof SqliteClient_1.DatabaseError) {
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
    app.patch('/databases/:id/schema/tables/:table/columns/:column/rename', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id, table, column } = request.params;
        const body = request.body || {};
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        if (typeof body.name !== 'string' || !body.name.trim()) {
            return reply.status(400).send({ ok: false, error: 'name is required' });
        }
        try {
            const result = await schemaService.renameColumn(id, table, column, body.name.trim(), request.user?.sub);
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof SqliteClient_1.DatabaseError) {
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
    app.patch('/databases/:id/schema/tables/:table/columns/:column/type', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id, table, column } = request.params;
        const body = request.body || {};
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        if (typeof body.type !== 'string' || !body.type.trim()) {
            return reply.status(400).send({ ok: false, error: 'type is required' });
        }
        try {
            const result = await schemaService.changeColumnType(id, table, column, body.type.trim(), request.user?.sub);
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof SqliteClient_1.DatabaseError) {
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
    app.delete('/databases/:id/schema/tables/:table/columns/:column', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id, table, column } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const result = await schemaService.deleteColumn(id, table, column, request.user?.sub);
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof SqliteClient_1.DatabaseError) {
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

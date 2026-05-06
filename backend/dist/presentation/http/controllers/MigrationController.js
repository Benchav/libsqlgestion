"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrationRoutes;
const MigrationService_1 = require("../../../application/databases/MigrationService");
const guards_1 = require("../guards");
const SqliteClient_1 = require("../../../infrastructure/sqlite/SqliteClient");
async function migrationRoutes(app) {
    const migrationService = new MigrationService_1.MigrationService();
    app.get('/databases/:id/migrations', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            return reply.send({ migrations: await migrationService.list(id) });
        }
        catch (error) {
            if (error.name === 'EntityNotFoundError') {
                return reply.status(404).send({ error: 'Database not found', migrations: [] });
            }
            return reply.status(500).send({ error: error.message || 'Failed to list migrations', migrations: [] });
        }
    });
    app.post('/databases/:id/migrations', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const body = request.body;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        if (!body.name || (!body.sql && !body.statements))
            return reply.status(400).send({ error: 'name and sql/statements required' });
        try {
            const migration = await migrationService.apply(id, body);
            return reply.status(201).send({ migration });
        }
        catch (error) {
            if (error instanceof SqliteClient_1.DatabaseError) {
                return reply.status(422).send({
                    error: error.message,
                    code: error.code,
                    recoverable: error.recoverable,
                });
            }
            if (error.message?.includes('No SQL statements')) {
                return reply.status(400).send({ error: error.message });
            }
            return reply.status(422).send({
                error: error.message || 'Migration failed',
            });
        }
    });
}

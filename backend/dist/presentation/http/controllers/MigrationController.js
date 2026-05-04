"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrationRoutes;
const MigrationService_1 = require("../../../application/databases/MigrationService");
const guards_1 = require("../guards");
async function migrationRoutes(app) {
    const migrationService = new MigrationService_1.MigrationService();
    app.get('/databases/:id/migrations', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        return reply.send({ migrations: await migrationService.list(id) });
    });
    app.post('/databases/:id/migrations', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const body = request.body;
        if (!body.name || (!body.sql && !body.statements))
            return reply.status(400).send({ error: 'name and sql/statements required' });
        const migration = await migrationService.apply(id, body);
        return reply.status(201).send({ migration });
    });
}

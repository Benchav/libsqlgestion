"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = databaseRoutes;
const DatabaseService_1 = require("../../../application/databases/DatabaseService");
const guards_1 = require("../guards");
async function databaseRoutes(app) {
    const databaseService = new DatabaseService_1.DatabaseService();
    app.get('/databases', { preHandler: [app.authenticate] }, async (_request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(_request, reply, 'databases.read')))
            return;
        const databases = await databaseService.listDatabases();
        return reply.send({ databases });
    });
    app.post('/databases', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = request.body;
        if (!body.projectId || !body.name || !body.type)
            return reply.status(400).send({ error: 'projectId, name and type required' });
        const result = await databaseService.createDatabase(body.projectId, body);
        return reply.status(201).send({ database: result.database, token: result.token });
    });
    app.get('/databases/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const database = await databaseService.getDatabase(id);
        if (!database)
            return reply.status(404).send({ error: 'database not found' });
        return reply.send({ database });
    });
    app.patch('/databases/:id/rotate-token', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const result = await databaseService.rotateToken(id);
        return reply.send({ database: result.database, token: result.token });
    });
    app.post('/databases/:id/test-connection', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const result = await databaseService.testConnection(id);
        return reply.send(result);
    });
}

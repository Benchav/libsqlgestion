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
        const query = _request.query || {};
        const databases = await databaseService.listDatabases(query.projectId);
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
    app.post('/databases/import-sqlite', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = request.body;
        if (!body.projectId || !body.name || !body.sourcePath)
            return reply.status(400).send({ error: 'projectId, name and sourcePath required' });
        const result = await databaseService.importExistingSqlite(body.projectId, body);
        return reply.status(201).send(result);
    });
    app.get('/databases/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const database = await databaseService.getDatabase(id);
        if (!database)
            return reply.status(404).send({ error: 'database not found' });
        return reply.send({ database });
    });
    app.patch('/databases/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const body = request.body;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const database = await databaseService.updateDatabase(id, body);
            return reply.send({ database });
        }
        catch (err) {
            return reply.status(404).send({ error: err.message });
        }
    });
    app.delete('/databases/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const result = await databaseService.deleteDatabase(id);
            return reply.send(result);
        }
        catch (err) {
            return reply.status(404).send({ error: err.message });
        }
    });
    app.patch('/databases/:id/rotate-token', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const result = await databaseService.rotateToken(id);
        return reply.send({ database: result.database, token: result.token });
    });
    app.post('/databases/:id/test-connection', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        const result = await databaseService.testConnection(id);
        return reply.send(result);
    });
}

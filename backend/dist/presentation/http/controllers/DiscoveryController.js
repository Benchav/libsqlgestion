"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = discoveryRoutes;
const DiscoveryService_1 = require("../../../application/databases/DiscoveryService");
const guards_1 = require("../guards");
async function discoveryRoutes(app) {
    const discoveryService = new DiscoveryService_1.DiscoveryService();
    app.post('/discovery/sqlite/scan', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = request.body;
        if (!body.projectId)
            return reply.status(400).send({ error: 'projectId required' });
        const access = await (0, guards_1.ensureProjectAccess)(request, reply, body.projectId);
        if (!access)
            return;
        const result = await discoveryService.scanMountedDirectory(body.projectId, body.rootPath, Boolean(body.adopt));
        return reply.send(result);
    });
    app.post('/discovery/sqlite/adopt', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = request.body;
        if (!body.projectId || !body.rootPath)
            return reply.status(400).send({ error: 'projectId and rootPath required' });
        const access = await (0, guards_1.ensureProjectAccess)(request, reply, body.projectId);
        if (!access)
            return;
        const result = await discoveryService.scanMountedDirectory(body.projectId, body.rootPath, true);
        return reply.send(result);
    });
}

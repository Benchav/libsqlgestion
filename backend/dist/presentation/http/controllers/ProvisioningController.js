"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = provisioningRoutes;
const ProvisioningService_1 = require("../../../application/provisioning/ProvisioningService");
const guards_1 = require("../guards");
async function provisioningRoutes(app) {
    const provisioningService = new ProvisioningService_1.ProvisioningService();
    app.post('/provisioning/sqlite', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = request.body;
        if (!body.projectId || !body.name)
            return reply.status(400).send({ error: 'projectId and name required' });
        const result = await provisioningService.provisionSqlite(body.projectId, body.name, body.subdomain);
        return reply.status(201).send(result);
    });
    app.post('/provisioning/libsql', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const body = request.body;
        if (!body.projectId || !body.name || !body.url || !body.token)
            return reply.status(400).send({ error: 'projectId, name, url and token required' });
        const result = await provisioningService.provisionLibsql(body.projectId, body);
        return reply.status(201).send(result);
    });
}

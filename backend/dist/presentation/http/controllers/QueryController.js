"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = queryRoutes;
const QueryService_1 = require("../../../application/databases/QueryService");
const guards_1 = require("../guards");
async function queryRoutes(app) {
    const queryService = new QueryService_1.QueryService();
    app.post('/databases/:id/query', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const body = request.body;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        if (!body.sql)
            return reply.status(400).send({ error: 'sql required' });
        const result = await queryService.execute(id, body.sql, body.params ?? []);
        return reply.send(result);
    });
}

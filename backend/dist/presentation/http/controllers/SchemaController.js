"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = schemaRoutes;
const SchemaService_1 = require("../../../application/databases/SchemaService");
const guards_1 = require("../guards");
async function schemaRoutes(app) {
    const schemaService = new SchemaService_1.SchemaService();
    app.get('/databases/:id/schema', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        return reply.send(await schemaService.getSchema(id));
    });
}

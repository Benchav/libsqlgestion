"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = schemaRoutes;
const SchemaService_1 = require("../../../application/databases/SchemaService");
const guards_1 = require("../guards");
const SqliteClient_1 = require("../../../infrastructure/sqlite/SqliteClient");
async function schemaRoutes(app) {
    const schemaService = new SchemaService_1.SchemaService();
    app.get('/databases/:id/schema', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.read')))
            return;
        const { id } = request.params;
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            return reply.send(await schemaService.getSchema(id));
        }
        catch (error) {
            if (error instanceof SqliteClient_1.DatabaseError) {
                return reply.status(error.recoverable ? 503 : 500).send({
                    error: error.message,
                    code: error.code,
                    tables: [],
                    views: [],
                });
            }
            if (error.name === 'EntityNotFoundError') {
                return reply.status(404).send({ error: 'Database not found', tables: [], views: [] });
            }
            return reply.status(500).send({
                error: error.message || 'Failed to retrieve database schema.',
                tables: [],
                views: [],
            });
        }
    });
}

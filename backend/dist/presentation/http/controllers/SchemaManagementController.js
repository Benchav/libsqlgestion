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
}

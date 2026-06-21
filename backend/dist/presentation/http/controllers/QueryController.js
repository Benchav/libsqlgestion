"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = queryRoutes;
const QueryService_1 = require("../../../application/databases/QueryService");
const guards_1 = require("../guards");
const SqliteClient_1 = require("../../../infrastructure/sqlite/SqliteClient");
const validations_1 = require("../../../types/validations");
async function queryRoutes(app) {
    const queryService = new QueryService_1.QueryService();
    app.post('/databases/:id/query', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'databases.write')))
            return;
        const { id } = request.params;
        const body = (0, validations_1.parseAndValidate)(validations_1.executeQuerySchema, request.body, 'query');
        const access = await (0, guards_1.ensureDatabaseAccess)(request, reply, id);
        if (!access)
            return;
        try {
            const result = await queryService.execute(id, body.sql, body.params);
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof SqliteClient_1.DatabaseError) {
                const statusCode = error.code === 'SQLITE_SYNTAX' || error.code === 'SQLITE_CONSTRAINT' || error.code === 'SQLITE_NO_TABLE' || error.code === 'SQLITE_NO_COLUMN'
                    ? 422
                    : error.code === 'SQLITE_BUSY'
                        ? 503
                        : 500;
                return reply.status(statusCode).send({
                    ok: false,
                    error: error.message,
                    code: error.code,
                    recoverable: error.recoverable,
                });
            }
            if (error.name === 'EntityNotFoundError') {
                return reply.status(404).send({ ok: false, error: 'Database not found' });
            }
            return reply.status(500).send({
                ok: false,
                error: error.message || 'An unexpected error occurred while executing the query.',
            });
        }
    });
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = healthRoutes;
const data_source_1 = require("../../../infrastructure/db/data-source");
async function healthRoutes(app) {
    app.get('/health', async (_request, reply) => {
        return reply.send({ ok: true, service: 'libsqlite-backend', timestamp: new Date().toISOString() });
    });
    app.get('/ready', async (_request, reply) => {
        if (!data_source_1.AppDataSource.isInitialized) {
            return reply.code(503).send({ ok: false, reason: 'database not initialized' });
        }
        try {
            await data_source_1.AppDataSource.query('SELECT 1');
            return reply.send({ ok: true });
        }
        catch (error) {
            return reply.code(503).send({ ok: false, reason: error.message });
        }
    });
}

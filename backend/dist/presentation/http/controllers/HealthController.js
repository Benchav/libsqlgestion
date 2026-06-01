"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = healthRoutes;
const data_source_1 = require("../../../infrastructure/db/data-source");
const Database_1 = require("../../../domain/entities/Database");
async function healthRoutes(app) {
    app.get('/health', async (_request, reply) => {
        const runtimeSummary = await summarizeRuntimeHealth().catch(() => null);
        return reply.send({ ok: true, service: 'libsqlite-backend', timestamp: new Date().toISOString(), runtimeSummary });
    });
    app.get('/ready', async (_request, reply) => {
        if (!data_source_1.AppDataSource.isInitialized) {
            return reply.code(503).send({ ok: false, reason: 'database not initialized' });
        }
        try {
            await data_source_1.AppDataSource.query('SELECT 1');
            const runtimeSummary = await summarizeRuntimeHealth();
            if (runtimeSummary.unhealthyPublicRuntimeCount > 0) {
                return reply.code(503).send({
                    ok: false,
                    reason: 'one or more public runtimes are unhealthy',
                    runtimeSummary,
                });
            }
            return reply.send({ ok: true, runtimeSummary });
        }
        catch (error) {
            return reply.code(503).send({ ok: false, reason: error.message });
        }
    });
}
async function summarizeRuntimeHealth() {
    if (!data_source_1.AppDataSource.isInitialized) {
        return {
            publicRuntimeCount: 0,
            healthyPublicRuntimeCount: 0,
            unhealthyPublicRuntimeCount: 0,
            provisioningCount: 0,
            errorCount: 0,
        };
    }
    const databases = await data_source_1.AppDataSource.getRepository(Database_1.Database).find();
    let publicRuntimeCount = 0;
    let healthyPublicRuntimeCount = 0;
    let unhealthyPublicRuntimeCount = 0;
    let provisioningCount = 0;
    let errorCount = 0;
    for (const database of databases) {
        if (database.status === 'provisioning')
            provisioningCount += 1;
        if (database.status === 'error')
            errorCount += 1;
        const runtime = database.metadata?.runtime;
        if (runtime?.provider !== 'docker-libsql') {
            continue;
        }
        publicRuntimeCount += 1;
        const internalOk = Boolean(runtime.routeHealth?.internalOk);
        const backendOk = Boolean(runtime.routeHealth?.backendOk);
        const publicChecked = Boolean(runtime.routeHealth?.publicChecked);
        const publicOk = Boolean(runtime.routeHealth?.publicOk);
        if (internalOk && backendOk && (!publicChecked || publicOk)) {
            healthyPublicRuntimeCount += 1;
        }
        else {
            unhealthyPublicRuntimeCount += 1;
        }
    }
    return {
        publicRuntimeCount,
        healthyPublicRuntimeCount,
        unhealthyPublicRuntimeCount,
        provisioningCount,
        errorCount,
    };
}

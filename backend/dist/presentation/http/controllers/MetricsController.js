"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = metricsRoutes;
const SystemMetricsService_1 = require("../../../application/metrics/SystemMetricsService");
async function metricsRoutes(app) {
    const metricsService = new SystemMetricsService_1.SystemMetricsService();
    app.get('/metrics', { preHandler: [app.authenticate] }, async (_request, reply) => {
        try {
            const metrics = await metricsService.getMetrics();
            return reply.send(metrics);
        }
        catch (error) {
            app.log.error(error);
            return reply.code(500).send({ ok: false, error: 'Failed to retrieve system metrics' });
        }
    });
}

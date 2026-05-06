"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = auditRoutes;
const AuditService_1 = require("../../../application/audit/AuditService");
const guards_1 = require("../guards");
async function auditRoutes(app) {
    const auditService = new AuditService_1.AuditService();
    app.get('/audit', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'audit.read')))
            return;
        const query = request.query || {};
        const page = Number.parseInt(String(query.page || '1'), 10);
        const limit = Number.parseInt(String(query.limit || '50'), 10);
        const search = typeof query.search === 'string' ? query.search : '';
        const result = await auditService.list({
            page: Number.isFinite(page) ? page : 1,
            limit: Number.isFinite(limit) ? limit : 50,
            search,
        });
        return reply.send(result);
    });
}

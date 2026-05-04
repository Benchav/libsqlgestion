"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = auditRoutes;
const AuditService_1 = require("../../../application/audit/AuditService");
const guards_1 = require("../guards");
async function auditRoutes(app) {
    const auditService = new AuditService_1.AuditService();
    app.get('/audit', { preHandler: [app.authenticate] }, async (_request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(_request, reply, 'audit.read')))
            return;
        const logs = await auditService.list();
        return reply.send({ logs });
    });
}

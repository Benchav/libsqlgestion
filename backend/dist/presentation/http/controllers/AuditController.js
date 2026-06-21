"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = auditRoutes;
const AuditService_1 = require("../../../application/audit/AuditService");
const guards_1 = require("../guards");
const validations_1 = require("../../../types/validations");
async function auditRoutes(app) {
    const auditService = new AuditService_1.AuditService();
    app.get('/audit', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'audit.read')))
            return;
        const query = (0, validations_1.parseAndValidate)(validations_1.auditListQuerySchema, request.query || {}, 'audit query');
        const result = await auditService.list({
            page: query.page,
            limit: query.limit,
            search: query.search,
        });
        return reply.send(result);
    });
}

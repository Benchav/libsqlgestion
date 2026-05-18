"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = settingsRoutes;
const guards_1 = require("../guards");
const PlatformSettingsService_1 = require("../../../application/settings/PlatformSettingsService");
async function settingsRoutes(app) {
    app.get('/settings/public-database', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'settings.read')))
            return;
        return reply.send({ settings: (0, PlatformSettingsService_1.getPublicDatabaseSettings)() });
    });
    app.put('/settings/public-database', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'settings.write')))
            return;
        const body = request.body || {};
        const settings = await (0, PlatformSettingsService_1.updatePublicDatabaseSettings)({
            domain: body.domain,
            template: body.template,
            baseUrl: body.baseUrl,
            host: body.host,
            protocol: body.protocol,
        });
        return reply.send({ settings });
    });
}

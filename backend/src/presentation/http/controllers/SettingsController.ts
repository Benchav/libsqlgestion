import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensurePermission } from '../guards';
import { getPublicDatabaseSettings, updatePublicDatabaseSettings } from '../../../application/settings/PlatformSettingsService';
import { publicDatabaseSettingsSchema, parseAndValidate } from '../../../types/validations';

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings/public-database', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.read'))) return;
    return reply.send({ settings: getPublicDatabaseSettings() });
  });

  app.put('/settings/public-database', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.write'))) return;
    const body = parseAndValidate(publicDatabaseSettingsSchema, request.body || {}, 'settings');
    const settings = await updatePublicDatabaseSettings(body);
    return reply.send({ settings });
  });
}

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensurePermission } from '../guards';
import { getPublicDatabaseSettings, updatePublicDatabaseSettings } from '../../../application/settings/PlatformSettingsService';

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings/public-database', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.read'))) return;
    return reply.send({ settings: getPublicDatabaseSettings() });
  });

  app.put('/settings/public-database', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.write'))) return;
    const body = (request.body as any) || {};
    const settings = await updatePublicDatabaseSettings({
      domain: body.domain,
      template: body.template,
      baseUrl: body.baseUrl,
      host: body.host,
      protocol: body.protocol,
    });

    return reply.send({ settings });
  });
}
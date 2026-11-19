import crypto from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensurePermission } from '../guards';
import { getPublicDatabaseSettings, updatePublicDatabaseSettings } from '../../../application/settings/PlatformSettingsService';
import { publicDatabaseSettingsSchema, parseAndValidate } from '../../../types/validations';
import { resolvePublicHost } from '../../../infrastructure/network/public-dns';

function normalizeDomain(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

function isValidDomain(domain: string) {
  return Boolean(domain)
    && domain !== 'localhost'
    && !/^\d+\.\d+\.\d+\.\d+$/.test(domain)
    && /^[a-z0-9.-]+$/.test(domain)
    && !domain.includes('..')
    && !domain.startsWith('-')
    && !domain.endsWith('-');
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings/public-database', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.read'))) return;
    return reply.send({ settings: getPublicDatabaseSettings() });
  });

  app.get('/settings/public-database/dns-check', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.read'))) return;

    const query = request.query as { domain?: string };
    const settings = getPublicDatabaseSettings();
    const domain = normalizeDomain(query.domain || settings.domain);
    if (!isValidDomain(domain)) {
      return reply.status(422).send({
        error: 'Enter a valid database domain (for example data.example.com).',
      });
    }

    const probe = `probe-${crypto.randomBytes(4).toString('hex')}.${domain}`;
    const record = `*.${domain}`;
    const result = await resolvePublicHost(probe);

    if (result.notFound) {
      return reply.send({
        ok: false,
        domain,
        probe,
        record,
        resolver: result.resolver,
        error: `No public DNS record found for ${record}. Create a wildcard DNS record for ${record} in Cloudflare.`,
      });
    }

    if (!result.addresses.length) {
      return reply.status(502).send({
        ok: false,
        domain,
        probe,
        record,
        resolver: result.resolver,
        error: `Could not verify ${record}: ${(result.error as any)?.message || String(result.error || 'DNS lookup failed.')}`,
      });
    }

    return reply.send({
      ok: true,
      domain,
      probe,
      record,
      resolver: result.resolver,
      addresses: result.addresses,
      warning: result.warning,
      message: `${record} resolves to ${result.addresses.join(', ')}.`,
    });
  });

  app.put('/settings/public-database', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.write'))) return;
    const body = parseAndValidate(publicDatabaseSettingsSchema, request.body || {}, 'settings');
    const settings = await updatePublicDatabaseSettings(body);
    return reply.send({ settings });
  });
}

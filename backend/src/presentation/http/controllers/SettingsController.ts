import crypto from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensurePermission } from '../guards';
import { getPublicDatabaseSettings, updatePublicDatabaseSettings } from '../../../application/settings/PlatformSettingsService';
import {
  getOffsiteBackupSettings,
  isOffsiteReady,
  updateOffsiteBackupSettings,
} from '../../../application/settings/OffsiteBackupSettingsService';
import { getOffsiteBackupService } from '../../../application/offsite/OffsiteBackupService';
import { AuditService } from '../../../application/audit/AuditService';
import {
  offsiteBackupSettingsSchema,
  offsiteSyncSchema,
  publicDatabaseSettingsSchema,
  parseAndValidate,
} from '../../../types/validations';
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

  const offsiteService = getOffsiteBackupService();
  const auditService = new AuditService();

  app.get('/settings/offsite-backup', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.read'))) return;
    return reply.send({
      settings: getOffsiteBackupSettings(),
      status: await offsiteService.getStatus(),
    });
  });

  app.put('/settings/offsite-backup', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.write'))) return;
    try {
      const body = parseAndValidate(offsiteBackupSettingsSchema, request.body || {}, 'offsite settings');
      const settings = await updateOffsiteBackupSettings(body);
      await auditService.record({
        action: 'settings.offsite_backup.update',
        resourceType: 'settings',
        actorId: (request as any).user?.sub,
        ipAddress: request.ip,
        metadata: {
          enabled: settings.enabled,
          endpoint: settings.endpoint,
          bucket: settings.bucket,
          prefix: settings.prefix,
          uploadMode: settings.uploadMode,
          artifacts: settings.artifacts,
          retentionDays: settings.retentionDays,
        },
      });
      if (settings.enabled) {
        void offsiteService.resumePending().catch((error: any) => {
          console.warn('[offsite] could not resume after settings update:', error?.message || error);
        });
      }
      return reply.send({
        settings,
        status: await offsiteService.getStatus(),
      });
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({
        error: error?.message || 'failed to save offsite settings',
      });
    }
  });

  app.post('/settings/offsite-backup/test', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.write'))) return;
    if (!isOffsiteReady()) {
      return reply.status(422).send({
        error: 'Save the offsite endpoint, bucket and credentials before testing the connection.',
      });
    }
    try {
      const result = await offsiteService.testConnection();
      await auditService.record({
        action: 'settings.offsite_backup.test',
        resourceType: 'settings',
        actorId: (request as any).user?.sub,
        ipAddress: request.ip,
        metadata: { ok: true, latencyMs: result.latencyMs, bucket: result.bucket },
      });
      return reply.send(result);
    } catch (error: any) {
      await auditService.record({
        action: 'settings.offsite_backup.test',
        resourceType: 'settings',
        actorId: (request as any).user?.sub,
        ipAddress: request.ip,
        metadata: { ok: false, error: String(error?.message || error).slice(0, 500) },
      }).catch(() => undefined);
      return reply.status(error?.statusCode || 502).send({
        error: error?.message || 'offsite connection failed',
      });
    }
  });

  app.post('/settings/offsite-backup/sync', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'settings.write'))) return;
    const body = parseAndValidate(offsiteSyncSchema, request.body || {}, 'offsite sync');
    try {
      const result = await offsiteService.syncPending(body);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({
        error: error?.message || 'failed to queue offsite uploads',
      });
    }
  });
}

import crypto from 'crypto';
import dns from 'dns';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensurePermission } from '../guards';
import { getPublicDatabaseSettings, updatePublicDatabaseSettings } from '../../../application/settings/PlatformSettingsService';
import { publicDatabaseSettingsSchema, parseAndValidate } from '../../../types/validations';

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

async function queryDoh(probe: string, type: 'A' | 'AAAA'): Promise<string[] | null> {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(probe)}&type=${type}`,
    { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) },
  );
  if (!response.ok) {
    throw new Error(`DoH request failed with ${response.status}`);
  }

  const payload = await response.json() as {
    Status?: number;
    Answer?: Array<{ type?: number; data?: string }>;
  };

  if (payload.Status === 3) {
    return null;
  }
  if (payload.Status !== 0) {
    throw new Error(`DoH returned status ${payload.Status}`);
  }

  const expectedType = type === 'A' ? 1 : 28;
  return (payload.Answer || [])
    .filter((entry) => entry.type === expectedType && typeof entry.data === 'string')
    .map((entry) => entry.data as string);
}

async function resolvePublicProbe(probe: string) {
  try {
    const ipv4 = await queryDoh(probe, 'A');
    if (ipv4 === null) {
      return { addresses: [] as string[], resolver: 'doh' as const, notFound: true };
    }
    if (ipv4.length > 0) {
      return { addresses: ipv4, resolver: 'doh' as const };
    }

    const ipv6 = await queryDoh(probe, 'AAAA');
    if (ipv6 === null) {
      return { addresses: [] as string[], resolver: 'doh' as const, notFound: true };
    }
    if (ipv6.length > 0) {
      return { addresses: ipv6, resolver: 'doh' as const };
    }

    return { addresses: [] as string[], resolver: 'doh' as const, notFound: true };
  } catch {
    // Fall through to DNS resolvers if HTTPS/DoH is unavailable.
  }

  const publicResolver = new dns.promises.Resolver();
  publicResolver.setServers(['1.1.1.1', '8.8.8.8']);

  let publicError: any = null;
  try {
    const addresses = await publicResolver.resolve4(probe);
    return { addresses, resolver: 'public' as const };
  } catch (error: any) {
    publicError = error;
  }

  try {
    const addresses = await publicResolver.resolve6(probe);
    return { addresses, resolver: 'public' as const };
  } catch (error: any) {
    publicError = error;
  }

  const publicCode = String(publicError?.code || '');
  if (publicCode === 'ENOTFOUND' || publicCode === 'ENODATA') {
    return { addresses: [] as string[], resolver: 'public' as const, notFound: true };
  }

  // The container may not be allowed to reach 1.1.1.1/8.8.8.8. Fall back to
  // the system resolver, but mark the result as less authoritative.
  try {
    const result = await dns.promises.lookup(probe, { all: true });
    return {
      addresses: result.map((entry) => entry.address),
      resolver: 'system' as const,
      warning: 'The public DNS resolver was unreachable; this result came from the container resolver.',
    };
  } catch (systemError: any) {
    return {
      addresses: [] as string[],
      resolver: 'system' as const,
      notFound: ['ENOTFOUND', 'ENODATA'].includes(String(systemError?.code || '')),
      error: publicError || systemError,
    };
  }
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
    const result = await resolvePublicProbe(probe);

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
        error: `Could not verify ${record}: ${result.error?.message || result.error || 'DNS lookup failed.'}`,
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

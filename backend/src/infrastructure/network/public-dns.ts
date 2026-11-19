import dns from 'dns';

export type PublicDnsResult = {
  addresses: string[];
  resolver: 'doh' | 'public' | 'system';
  notFound?: boolean;
  warning?: string;
  error?: unknown;
};

async function queryDoh(host: string, type: 'A' | 'AAAA'): Promise<string[] | null> {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
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

/**
 * Resolves a public hostname independently of the container's local resolver.
 * This avoids false NXDOMAIN results caused by negative DNS caching after a
 * wildcard record is created.
 */
export async function resolvePublicHost(host: string): Promise<PublicDnsResult> {
  const normalized = host.trim().replace(/\.+$/, '');
  if (!normalized) {
    return { addresses: [], resolver: 'system', notFound: true, error: new Error('Empty hostname') };
  }

  try {
    const ipv4 = await queryDoh(normalized, 'A');
    if (ipv4 === null) {
      return { addresses: [], resolver: 'doh', notFound: true };
    }
    if (ipv4.length > 0) {
      return { addresses: ipv4, resolver: 'doh' };
    }

    const ipv6 = await queryDoh(normalized, 'AAAA');
    if (ipv6 === null) {
      return { addresses: [], resolver: 'doh', notFound: true };
    }
    if (ipv6.length > 0) {
      return { addresses: ipv6, resolver: 'doh' };
    }

    return { addresses: [], resolver: 'doh', notFound: true };
  } catch {
    // Fall through to DNS resolvers if HTTPS/DoH is unavailable.
  }

  const publicResolver = new dns.promises.Resolver();
  publicResolver.setServers(['1.1.1.1', '8.8.8.8']);

  let publicError: unknown = null;
  try {
    const addresses = await publicResolver.resolve4(normalized);
    return { addresses, resolver: 'public' };
  } catch (error) {
    publicError = error;
  }

  try {
    const addresses = await publicResolver.resolve6(normalized);
    return { addresses, resolver: 'public' };
  } catch (error) {
    publicError = error;
  }

  const publicCode = String((publicError as any)?.code || '');
  if (publicCode === 'ENOTFOUND' || publicCode === 'ENODATA') {
    return { addresses: [], resolver: 'public', notFound: true };
  }

  try {
    const result = await dns.promises.lookup(normalized, { all: true });
    return {
      addresses: result.map((entry) => entry.address),
      resolver: 'system',
      warning: 'The public DNS resolver was unreachable; this result came from the container resolver.',
    };
  } catch (systemError) {
    const code = String((systemError as any)?.code || '');
    return {
      addresses: [],
      resolver: 'system',
      notFound: code === 'ENOTFOUND' || code === 'ENODATA',
      error: publicError || systemError,
    };
  }
}

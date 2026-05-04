const COOKIE_BASE = ['Path=/api/v1', 'HttpOnly', 'SameSite=Lax'];

export function parseCookies(headerValue?: string) {
  const cookies: Record<string, string> = {};
  if (!headerValue) return cookies;

  for (const chunk of headerValue.split(';')) {
    const index = chunk.indexOf('=');
    if (index === -1) continue;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

export function sessionCookie(name: string, value: string, maxAgeSeconds: number) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${maxAgeSeconds}`, ...COOKIE_BASE];
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearSessionCookie(name: string) {
  const parts = [`${name}=`, 'Max-Age=0', ...COOKIE_BASE];
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

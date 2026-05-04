import { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { parseCookies } from '../../infrastructure/security/cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE_NAME = 'libsqlite.csrfToken.v2';
const CSRF_EXEMPT_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/health',
  '/api/v1/ready',
];

export function issueCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function requireCsrf(request: FastifyRequest, reply: FastifyReply) {
  if (SAFE_METHODS.has(request.method)) return true;
  if (CSRF_EXEMPT_PATHS.some((path) => request.url.startsWith(path))) return true;

  const cookies = parseCookies(request.headers.cookie);
  const cookieToken = cookies[CSRF_COOKIE_NAME] || cookies['libsqlite.csrfToken'];
  const headerToken = request.headers['x-csrf-token-v2'] || request.headers['x-csrf-token'];
  const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;

  if (!cookieToken || !provided || cookieToken !== provided) {
    reply.code(403).send({ error: 'invalid csrf token' });
    return false;
  }

  return true;
}

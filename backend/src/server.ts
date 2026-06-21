import fastify from 'fastify';
import compress from '@fastify/compress';
import multipart from '@fastify/multipart';
import routes from './presentation/http/routes';
import { AuthService } from './application/auth/AuthService';
import { securityPlugin } from './presentation/http/plugins/security';
import { parseCookies } from './infrastructure/security/cookies';
import { requireCsrf } from './presentation/http/csrf';
import { ValidationError } from './types/validations';

export function buildServer() {
  const app = fastify({ logger: true, trustProxy: true });
  const authService = new AuthService();

  app.register(compress, { global: true });
  app.register(multipart, {
    limits: {
      fileSize: Number(process.env.MAX_UPLOAD_SIZE_BYTES || 524288000),
    },
  });
  app.register(securityPlugin);
  app.addHook('preHandler', async (request, reply) => {
    if (!requireCsrf(request, reply)) {
      return reply;
    }
  });
  app.decorate('authenticate', async function (request: any, reply: any) {
    const authorization = request.headers.authorization;
    const cookies = parseCookies(request.headers.cookie);
    const accessToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : cookies['libsqlite.accessToken'];

    if (!accessToken) {
      return reply.code(401).send({ error: 'missing session' });
    }

    const user = await authService.validateAccessToken(accessToken);
    if (!user) {
      return reply.code(401).send({ error: 'invalid or expired token' });
    }

    request.user = { sub: user.id, email: user.email };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) {
      return reply.status(422).send({
        error: error.message,
        code: 'VALIDATION_ERROR',
        details: error.issues,
      });
    }

    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: 'too many requests',
        code: 'RATE_LIMITED',
      });
    }

    requestErrorLogger(_request, error);
    return reply.status(error.statusCode || 500).send({
      error: error.message || 'internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  app.register(routes, { prefix: '/api/v1' });

  return app;
}

const requestErrorLogger = (_request: any, error: Error & { statusCode?: number }) => {
  if (error.statusCode === 429 || error.statusCode === 401 || error.statusCode === 403) {
    return;
  }
  console.error(`[${new Date().toISOString()}] Request error: ${error.message}`, {
    method: _request?.method || 'unknown',
    url: _request?.url || 'unknown',
    statusCode: error.statusCode,
  });
};

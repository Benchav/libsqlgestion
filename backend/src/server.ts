import fastify from 'fastify';
import routes from './presentation/http/routes';
import { AuthService } from './application/auth/AuthService';
import { securityPlugin } from './presentation/http/plugins/security';
import { parseCookies } from './infrastructure/security/cookies';
import { requireCsrf } from './presentation/http/csrf';

export function buildServer() {
  const app = fastify({ logger: true, trustProxy: true });
  const authService = new AuthService();

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
  app.register(routes, { prefix: '/api/v1' });

  return app;
}

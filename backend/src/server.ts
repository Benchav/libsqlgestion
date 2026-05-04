import fastify from 'fastify';
import routes from './presentation/http/routes';
import { AuthService } from './application/auth/AuthService';
import { securityPlugin } from './presentation/http/plugins/security';

export function buildServer() {
  const app = fastify({ logger: true, trustProxy: true });
  const authService = new AuthService();

  app.register(securityPlugin);
  app.decorate('authenticate', async function (request: any, reply: any) {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing bearer token' });
    }

    const accessToken = authorization.slice('Bearer '.length).trim();
    const user = await authService.validateAccessToken(accessToken);
    if (!user) {
      return reply.code(401).send({ error: 'invalid or expired token' });
    }

    request.user = { sub: user.id, email: user.email };
  });
  app.register(routes, { prefix: '/api/v1' });

  return app;
}

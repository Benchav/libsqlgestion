import fastify from 'fastify';
import jwt from '@fastify/jwt';
import routes from './presentation/http/routes';

export function buildServer() {
  const app = fastify({ logger: true });
  app.register(jwt, { secret: process.env.JWT_SECRET || 'change_me' });
  app.register(routes, { prefix: '/api/v1' });

  // simple decorator for protected routes
  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.send(err);
    }
  });

  return app;
}

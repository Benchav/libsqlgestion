import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../../../application/auth/AuthService';

export default async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService();

  app.post('/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    if (!body.email || !body.password) return reply.status(400).send({ error: 'email and password required' });
    try {
      const user = await authService.register(body.email, body.password);
      const token = app.jwt.sign({ sub: user.id, email: user.email });
      return reply.send({ user: { id: user.id, email: user.email }, token });
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.post('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    if (!body.email || !body.password) return reply.status(400).send({ error: 'email and password required' });
    const user = await authService.validateUser(body.email, body.password);
    if (!user) return reply.status(401).send({ error: 'invalid credentials' });
    const token = app.jwt.sign({ sub: user.id, email: user.email });
    return reply.send({ user: { id: user.id, email: user.email }, token });
  });

  app.get('/me', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    return reply.send({ user });
  });
}

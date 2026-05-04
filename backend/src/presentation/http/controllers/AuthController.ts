import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../../../application/auth/AuthService';
import { AuditService } from '../../../application/audit/AuditService';

export default async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService();
  const auditService = new AuditService();

  app.post('/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    if (!body.email || !body.password) return reply.status(400).send({ error: 'email and password required' });
    try {
      const user = await authService.register(body.email, body.password);
      const session = await authService.issueSession(user);
      await auditService.record({ action: 'auth.register', resourceType: 'user', resourceId: user.id });
      return reply.send({
        user: { id: user.id, email: user.email },
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.post('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    if (!body.email || !body.password) return reply.status(400).send({ error: 'email and password required' });
    const user = await authService.authenticate(body.email, body.password);
    if (!user) return reply.status(401).send({ error: 'invalid credentials' });
    const session = await authService.issueSession(user);
    await auditService.record({ action: 'auth.login', resourceType: 'user', resourceId: user.id });
    return reply.send({
      user: { id: user.id, email: user.email },
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    });
  });

  app.post('/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    if (!body.refreshToken) return reply.status(400).send({ error: 'refreshToken required' });
    const session = await authService.refresh(body.refreshToken);
    if (!session) return reply.status(401).send({ error: 'invalid refresh token' });
    return reply.send({
      user: { id: session.user.id, email: session.user.email },
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    });
  });

  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    if (!body.refreshToken) return reply.status(400).send({ error: 'refreshToken required' });
    await authService.logout(body.refreshToken);
    return reply.send({ ok: true });
  });

  app.get('/me', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    return reply.send({ user });
  });
}

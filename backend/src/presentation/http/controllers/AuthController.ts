import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../../../application/auth/AuthService';
import { AuditService } from '../../../application/audit/AuditService';
import { getUserPermissions } from '../../../application/auth/authorization';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { UserRole } from '../../../domain/entities/UserRole';
import { clearSessionCookie, parseCookies, sessionCookie } from '../../../infrastructure/security/cookies';

const ACCESS_TOKEN_MAX_AGE = 60 * 60 * 24 * 7;
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 30;

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
      reply.header('Set-Cookie', [
        sessionCookie('libsqlite.accessToken', session.accessToken, ACCESS_TOKEN_MAX_AGE),
        sessionCookie('libsqlite.refreshToken', session.refreshToken, REFRESH_TOKEN_MAX_AGE),
      ]);
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
    reply.header('Set-Cookie', [
      sessionCookie('libsqlite.accessToken', session.accessToken, ACCESS_TOKEN_MAX_AGE),
      sessionCookie('libsqlite.refreshToken', session.refreshToken, REFRESH_TOKEN_MAX_AGE),
    ]);
    return reply.send({
      user: { id: user.id, email: user.email },
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    });
  });

  app.post('/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const cookies = parseCookies(request.headers.cookie);
    const refreshToken = body.refreshToken || cookies['libsqlite.refreshToken'];
    if (!refreshToken) return reply.status(400).send({ error: 'refreshToken required' });
    const session = await authService.refresh(refreshToken);
    if (!session) return reply.status(401).send({ error: 'invalid refresh token' });
    reply.header('Set-Cookie', [
      sessionCookie('libsqlite.accessToken', session.accessToken, ACCESS_TOKEN_MAX_AGE),
      sessionCookie('libsqlite.refreshToken', session.refreshToken, REFRESH_TOKEN_MAX_AGE),
    ]);
    return reply.send({
      user: { id: session.user.id, email: session.user.email },
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    });
  });

  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const cookies = parseCookies(request.headers.cookie);
    const refreshToken = body.refreshToken || cookies['libsqlite.refreshToken'];
    if (refreshToken) {
      await authService.logout(refreshToken);
    }
    reply.header('Set-Cookie', [
      clearSessionCookie('libsqlite.accessToken'),
      clearSessionCookie('libsqlite.refreshToken'),
    ]);
    return reply.send({ ok: true });
  });

  app.get('/me', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    const permissions = await getUserPermissions(user.sub);

    const userRoleRepo = AppDataSource.getRepository(UserRole);
    const userRoles = await userRoleRepo.find({
      where: { user: { id: user.sub } },
      relations: ['role'],
    });
    const roles = userRoles.map((ur) => ur.role.name);

    return reply.send({
      user: {
        ...user,
        roles,
        permissions: Array.from(permissions),
      },
    });
  });
}

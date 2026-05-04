import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../../../application/auth/AuthService';
import { AuditService } from '../../../application/audit/AuditService';
import { getUserPermissions } from '../../../application/auth/authorization';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { UserRole } from '../../../domain/entities/UserRole';
import { clearSessionCookie, clearCsrfCookie, csrfCookie, parseCookies, sessionCookie } from '../../../infrastructure/security/cookies';
import { issueCsrfToken } from '../csrf';

const ACCESS_TOKEN_MAX_AGE = 60 * 60 * 24 * 7;
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 30;
const CSRF_TOKEN_MAX_AGE = 60 * 60 * 24 * 30;

function issueSessionCookies(accessToken: string, refreshToken: string) {
  const csrfToken = issueCsrfToken();
  return {
    csrfToken,
    cookies: [
      sessionCookie('libsqlite.accessToken', accessToken, ACCESS_TOKEN_MAX_AGE),
      sessionCookie('libsqlite.refreshToken', refreshToken, REFRESH_TOKEN_MAX_AGE),
      csrfCookie('libsqlite.csrfToken', csrfToken, CSRF_TOKEN_MAX_AGE),
    ],
  };
}

export default async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService();
  const auditService = new AuditService();

  app.post('/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    if (!body.email || !body.password) return reply.status(400).send({ error: 'email and password required' });
    if (typeof body.email !== 'string' || typeof body.password !== 'string') return reply.status(400).send({ error: 'invalid payload' });
    try {
      const user = await authService.register(body.email, body.password);
      const session = await authService.issueSession(user);
      await auditService.record({ action: 'auth.register', resourceType: 'user', resourceId: user.id });
      const issued = issueSessionCookies(session.accessToken, session.refreshToken);
      reply.header('Set-Cookie', issued.cookies);
      return reply.send({
        user: { id: user.id, email: user.email, csrfToken: issued.csrfToken },
      });
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.post('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    if (!body.email || !body.password) return reply.status(400).send({ error: 'email and password required' });
    if (typeof body.email !== 'string' || typeof body.password !== 'string') return reply.status(400).send({ error: 'invalid payload' });
    const user = await authService.authenticate(body.email, body.password);
    if (!user) return reply.status(401).send({ error: 'invalid credentials' });
    const session = await authService.issueSession(user);
    await auditService.record({ action: 'auth.login', resourceType: 'user', resourceId: user.id });
    const issued = issueSessionCookies(session.accessToken, session.refreshToken);
    reply.header('Set-Cookie', issued.cookies);
    return reply.send({
      user: { id: user.id, email: user.email, csrfToken: issued.csrfToken },
    });
  });

  app.post('/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const cookies = parseCookies(request.headers.cookie);
    const refreshToken = body.refreshToken || cookies['libsqlite.refreshToken'];
    if (!refreshToken) return reply.status(400).send({ error: 'refreshToken required' });
    if (body.refreshToken && typeof body.refreshToken !== 'string') return reply.status(400).send({ error: 'invalid payload' });
    const session = await authService.refresh(refreshToken);
    if (!session) return reply.status(401).send({ error: 'invalid refresh token' });
    const issued = issueSessionCookies(session.accessToken, session.refreshToken);
    reply.header('Set-Cookie', issued.cookies);
    return reply.send({
      user: { id: session.user.id, email: session.user.email, csrfToken: issued.csrfToken },
    });
  });

  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    if (body.refreshToken && typeof body.refreshToken !== 'string') return reply.status(400).send({ error: 'invalid payload' });
    const cookies = parseCookies(request.headers.cookie);
    const refreshToken = body.refreshToken || cookies['libsqlite.refreshToken'];
    if (refreshToken) {
      await authService.logout(refreshToken);
    }
    reply.header('Set-Cookie', [
      clearSessionCookie('libsqlite.accessToken'),
      clearSessionCookie('libsqlite.refreshToken'),
      clearCsrfCookie('libsqlite.csrfToken'),
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

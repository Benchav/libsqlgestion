"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = authRoutes;
const AuthService_1 = require("../../../application/auth/AuthService");
const AuditService_1 = require("../../../application/audit/AuditService");
const authorization_1 = require("../../../application/auth/authorization");
const data_source_1 = require("../../../infrastructure/db/data-source");
const UserRole_1 = require("../../../domain/entities/UserRole");
const cookies_1 = require("../../../infrastructure/security/cookies");
const csrf_1 = require("../csrf");
const ACCESS_TOKEN_MAX_AGE = 60 * 60 * 24 * 7;
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 30;
const CSRF_TOKEN_MAX_AGE = 60 * 60 * 24 * 30;
function issueSessionCookies(accessToken, refreshToken) {
    const csrfToken = (0, csrf_1.issueCsrfToken)();
    return {
        csrfToken,
        cookies: [
            (0, cookies_1.sessionCookie)('libsqlite.accessToken', accessToken, ACCESS_TOKEN_MAX_AGE),
            (0, cookies_1.sessionCookie)('libsqlite.refreshToken', refreshToken, REFRESH_TOKEN_MAX_AGE),
            (0, cookies_1.csrfCookie)('libsqlite.csrfToken.v2', csrfToken, CSRF_TOKEN_MAX_AGE),
        ],
    };
}
async function authRoutes(app) {
    const authService = new AuthService_1.AuthService();
    const auditService = new AuditService_1.AuditService();
    app.post('/auth/register', async (request, reply) => {
        const body = request.body;
        if (!body.email || !body.password)
            return reply.status(400).send({ error: 'email and password required' });
        if (typeof body.email !== 'string' || typeof body.password !== 'string')
            return reply.status(400).send({ error: 'invalid payload' });
        try {
            const user = await authService.register(body.email, body.password);
            const session = await authService.issueSession(user);
            await auditService.record({ action: 'auth.register', resourceType: 'user', resourceId: user.id });
            const issued = issueSessionCookies(session.accessToken, session.refreshToken);
            reply.header('Set-Cookie', issued.cookies);
            return reply.send({
                user: { id: user.id, email: user.email, csrfToken: issued.csrfToken },
            });
        }
        catch (err) {
            return reply.status(400).send({ error: err.message });
        }
    });
    app.post('/auth/login', async (request, reply) => {
        const body = request.body;
        if (!body.email || !body.password)
            return reply.status(400).send({ error: 'email and password required' });
        if (typeof body.email !== 'string' || typeof body.password !== 'string')
            return reply.status(400).send({ error: 'invalid payload' });
        const user = await authService.authenticate(body.email, body.password);
        if (!user)
            return reply.status(401).send({ error: 'invalid credentials' });
        const session = await authService.issueSession(user);
        await auditService.record({ action: 'auth.login', resourceType: 'user', resourceId: user.id });
        const issued = issueSessionCookies(session.accessToken, session.refreshToken);
        reply.header('Set-Cookie', issued.cookies);
        return reply.send({
            user: { id: user.id, email: user.email, csrfToken: issued.csrfToken },
        });
    });
    app.post('/auth/refresh', async (request, reply) => {
        const body = request.body;
        const cookies = (0, cookies_1.parseCookies)(request.headers.cookie);
        const refreshToken = body.refreshToken || cookies['libsqlite.refreshToken'];
        if (!refreshToken)
            return reply.status(400).send({ error: 'refreshToken required' });
        if (body.refreshToken && typeof body.refreshToken !== 'string')
            return reply.status(400).send({ error: 'invalid payload' });
        const session = await authService.refresh(refreshToken);
        if (!session)
            return reply.status(401).send({ error: 'invalid refresh token' });
        const issued = issueSessionCookies(session.accessToken, session.refreshToken);
        reply.header('Set-Cookie', issued.cookies);
        return reply.send({
            user: { id: session.user.id, email: session.user.email, csrfToken: issued.csrfToken },
        });
    });
    app.post('/auth/logout', async (request, reply) => {
        const body = request.body;
        if (body.refreshToken && typeof body.refreshToken !== 'string')
            return reply.status(400).send({ error: 'invalid payload' });
        const cookies = (0, cookies_1.parseCookies)(request.headers.cookie);
        const refreshToken = body.refreshToken || cookies['libsqlite.refreshToken'];
        if (refreshToken) {
            await authService.logout(refreshToken);
        }
        reply.header('Set-Cookie', [
            (0, cookies_1.clearSessionCookie)('libsqlite.accessToken'),
            (0, cookies_1.clearSessionCookie)('libsqlite.refreshToken'),
            (0, cookies_1.clearCsrfCookie)('libsqlite.csrfToken'),
            (0, cookies_1.clearCsrfCookie)('libsqlite.csrfToken.v2'),
        ]);
        return reply.send({ ok: true });
    });
    app.get('/me', { preHandler: [app.authenticate] }, async (request, reply) => {
        const user = request.user;
        const permissions = await (0, authorization_1.getUserPermissions)(user.sub);
        const userRoleRepo = data_source_1.AppDataSource.getRepository(UserRole_1.UserRole);
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

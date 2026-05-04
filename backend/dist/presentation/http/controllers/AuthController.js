"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = authRoutes;
const AuthService_1 = require("../../../application/auth/AuthService");
const AuditService_1 = require("../../../application/audit/AuditService");
async function authRoutes(app) {
    const authService = new AuthService_1.AuthService();
    const auditService = new AuditService_1.AuditService();
    app.post('/auth/register', async (request, reply) => {
        const body = request.body;
        if (!body.email || !body.password)
            return reply.status(400).send({ error: 'email and password required' });
        try {
            const user = await authService.register(body.email, body.password);
            const session = await authService.issueSession(user);
            await auditService.record({ action: 'auth.register', resourceType: 'user', resourceId: user.id });
            return reply.send({
                user: { id: user.id, email: user.email },
                accessToken: session.accessToken,
                refreshToken: session.refreshToken,
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
        const user = await authService.authenticate(body.email, body.password);
        if (!user)
            return reply.status(401).send({ error: 'invalid credentials' });
        const session = await authService.issueSession(user);
        await auditService.record({ action: 'auth.login', resourceType: 'user', resourceId: user.id });
        return reply.send({
            user: { id: user.id, email: user.email },
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
        });
    });
    app.post('/auth/refresh', async (request, reply) => {
        const body = request.body;
        if (!body.refreshToken)
            return reply.status(400).send({ error: 'refreshToken required' });
        const session = await authService.refresh(body.refreshToken);
        if (!session)
            return reply.status(401).send({ error: 'invalid refresh token' });
        return reply.send({
            user: { id: session.user.id, email: session.user.email },
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
        });
    });
    app.post('/auth/logout', async (request, reply) => {
        const body = request.body;
        if (!body.refreshToken)
            return reply.status(400).send({ error: 'refreshToken required' });
        await authService.logout(body.refreshToken);
        return reply.send({ ok: true });
    });
    app.get('/me', { preHandler: [app.authenticate] }, async (request, reply) => {
        const user = request.user;
        return reply.send({ user });
    });
}

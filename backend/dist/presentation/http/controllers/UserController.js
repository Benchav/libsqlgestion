"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = userRoutes;
const data_source_1 = require("../../../infrastructure/db/data-source");
const User_1 = require("../../../domain/entities/User");
const Role_1 = require("../../../domain/entities/Role");
const UserRole_1 = require("../../../domain/entities/UserRole");
const AuthService_1 = require("../../../application/auth/AuthService");
const AuditService_1 = require("../../../application/audit/AuditService");
const authorization_1 = require("../../../application/auth/authorization");
const guards_1 = require("../guards");
const validations_1 = require("../../../types/validations");
const user_presenter_1 = require("../user-presenter");
const SUPERADMIN_ONLY_ROLES = new Set(['superadmin']);
const ADMIN_MANAGED_ROLES = new Set(['operator', 'readonly']);
function canAssignRole(actorRoles, roleName) {
    if (actorRoles.includes('superadmin'))
        return true;
    return ADMIN_MANAGED_ROLES.has(roleName);
}
async function loadPresentedUser(userId) {
    const userRepo = data_source_1.AppDataSource.getRepository(User_1.User);
    const user = await userRepo.findOne({
        where: { id: userId },
        relations: ['roles', 'roles.role'],
    });
    return user ? (0, user_presenter_1.presentUser)(user) : null;
}
async function userRoutes(app) {
    const userRepo = data_source_1.AppDataSource.getRepository(User_1.User);
    const roleRepo = data_source_1.AppDataSource.getRepository(Role_1.Role);
    const userRoleRepo = data_source_1.AppDataSource.getRepository(UserRole_1.UserRole);
    const authService = new AuthService_1.AuthService();
    const auditService = new AuditService_1.AuditService();
    app.get('/users', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'users.read')))
            return;
        const users = await userRepo.find({ relations: ['roles', 'roles.role'] });
        return reply.send({ users: users.map((user) => (0, user_presenter_1.presentUser)(user)) });
    });
    app.post('/users', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'users.write')))
            return;
        const body = (0, validations_1.parseAndValidate)(validations_1.createUserSchema, request.body, 'create user');
        const actorId = request.user?.sub;
        const actorRoles = await (0, authorization_1.getUserRoles)(actorId);
        const roleName = body.roleName || 'readonly';
        if (!canAssignRole(actorRoles, roleName)) {
            return reply.status(403).send({ error: `not allowed to assign role: ${roleName}` });
        }
        try {
            const user = await authService.createUser(body.email, body.password, roleName);
            await auditService.record({
                action: 'user.create',
                resourceType: 'user',
                resourceId: user.id,
                actorId,
                ipAddress: request.ip,
                metadata: { email: user.email, roleName },
            });
            return reply.status(201).send({ user: await loadPresentedUser(user.id) });
        }
        catch (error) {
            return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to create user' });
        }
    });
    app.patch('/users/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'users.write')))
            return;
        const { id } = request.params;
        const body = (0, validations_1.parseAndValidate)(validations_1.updateUserSchema, request.body, 'update user');
        const actorId = request.user?.sub;
        const actorRoles = await (0, authorization_1.getUserRoles)(actorId);
        const target = await userRepo.findOne({ where: { id }, relations: ['roles', 'roles.role'] });
        if (!target)
            return reply.status(404).send({ error: 'user not found' });
        const targetRoles = (target.roles || [])
            .map((entry) => entry.role?.name)
            .filter((role) => Boolean(role));
        if (targetRoles.some((role) => SUPERADMIN_ONLY_ROLES.has(role)) && !actorRoles.includes('superadmin')) {
            return reply.status(403).send({ error: 'only a superadmin can modify a superadmin' });
        }
        if (id === actorId && body.active === false) {
            return reply.status(409).send({ error: 'you cannot deactivate your own account' });
        }
        try {
            await authService.adminUpdateUser(id, body);
            await auditService.record({
                action: 'user.update',
                resourceType: 'user',
                resourceId: id,
                actorId,
                ipAddress: request.ip,
                metadata: {
                    emailChanged: Boolean(body.email),
                    passwordReset: Boolean(body.password),
                    activeChanged: typeof body.active === 'boolean',
                },
            });
            return reply.send({ user: await loadPresentedUser(id) });
        }
        catch (error) {
            return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to update user' });
        }
    });
    app.post('/users/:id/roles', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'users.write')))
            return;
        const { id } = request.params;
        const body = (0, validations_1.parseAndValidate)(validations_1.assignRoleSchema, request.body, 'assign role');
        const actorId = request.user?.sub;
        const actorRoles = await (0, authorization_1.getUserRoles)(actorId);
        if (!canAssignRole(actorRoles, body.roleName)) {
            return reply.status(403).send({ error: `not allowed to assign role: ${body.roleName}` });
        }
        const user = await userRepo.findOneBy({ id });
        const role = await roleRepo.findOneBy({ name: body.roleName });
        if (!user || !role)
            return reply.status(404).send({ error: 'user or role not found' });
        const existing = await userRoleRepo.findOne({ where: { user: { id }, role: { id: role.id } }, relations: ['user', 'role'] });
        if (!existing) {
            await userRoleRepo.save(userRoleRepo.create({ user, role }));
        }
        (0, authorization_1.invalidateUserPermissionCache)(id);
        return reply.send({ ok: true });
    });
}

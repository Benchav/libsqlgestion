"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = userRoutes;
const data_source_1 = require("../../../infrastructure/db/data-source");
const User_1 = require("../../../domain/entities/User");
const Role_1 = require("../../../domain/entities/Role");
const UserRole_1 = require("../../../domain/entities/UserRole");
const guards_1 = require("../guards");
async function userRoutes(app) {
    const userRepo = data_source_1.AppDataSource.getRepository(User_1.User);
    const roleRepo = data_source_1.AppDataSource.getRepository(Role_1.Role);
    const userRoleRepo = data_source_1.AppDataSource.getRepository(UserRole_1.UserRole);
    app.get('/users', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'users.read')))
            return;
        const users = await userRepo.find({ relations: ['roles', 'roles.role', 'sessions'] });
        return reply.send({ users });
    });
    app.post('/users/:id/roles', { preHandler: [app.authenticate] }, async (request, reply) => {
        if (!(await (0, guards_1.ensurePermission)(request, reply, 'users.write')))
            return;
        const { id } = request.params;
        const body = request.body;
        if (!body.roleName)
            return reply.status(400).send({ error: 'roleName required' });
        const user = await userRepo.findOneBy({ id });
        const role = await roleRepo.findOneBy({ name: body.roleName });
        if (!user || !role)
            return reply.status(404).send({ error: 'user or role not found' });
        const existing = await userRoleRepo.findOne({ where: { user: { id }, role: { id: role.id } }, relations: ['user', 'role'] });
        if (!existing) {
            await userRoleRepo.save(userRoleRepo.create({ user, role }));
        }
        return reply.send({ ok: true });
    });
}

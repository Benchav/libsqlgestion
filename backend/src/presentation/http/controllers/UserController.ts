import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { User } from '../../../domain/entities/User';
import { Role } from '../../../domain/entities/Role';
import { UserRole } from '../../../domain/entities/UserRole';
import { invalidateUserPermissionCache } from '../../../application/auth/authorization';
import { ensurePermission } from '../guards';
import { assignRoleSchema, parseAndValidate } from '../../../types/validations';

export default async function userRoutes(app: FastifyInstance) {
  const userRepo = AppDataSource.getRepository(User);
  const roleRepo = AppDataSource.getRepository(Role);
  const userRoleRepo = AppDataSource.getRepository(UserRole);

  app.get('/users', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'users.read'))) return;
    const users = await userRepo.find({ relations: ['roles', 'roles.role', 'sessions'] as any });
    return reply.send({ users });
  });

  app.post('/users/:id/roles', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'users.write'))) return;
    const { id } = request.params as any;
    const body = parseAndValidate(assignRoleSchema, request.body, 'assign role');

    const user = await userRepo.findOneBy({ id });
    const role = await roleRepo.findOneBy({ name: body.roleName });
    if (!user || !role) return reply.status(404).send({ error: 'user or role not found' });

    const existing = await userRoleRepo.findOne({ where: { user: { id }, role: { id: role.id } }, relations: ['user', 'role'] });
    if (!existing) {
      await userRoleRepo.save(userRoleRepo.create({ user, role }));
    }

    invalidateUserPermissionCache(id);

    return reply.send({ ok: true });
  });
}

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { User } from '../../../domain/entities/User';
import { Role } from '../../../domain/entities/Role';
import { UserRole } from '../../../domain/entities/UserRole';
import { AuthService } from '../../../application/auth/AuthService';
import { AuditService } from '../../../application/audit/AuditService';
import { getUserRoles, invalidateUserPermissionCache } from '../../../application/auth/authorization';
import { ensurePermission } from '../guards';
import {
  assignRoleSchema,
  createUserSchema,
  parseAndValidate,
  updateUserSchema,
} from '../../../types/validations';
import { presentUser } from '../user-presenter';

const SUPERADMIN_ONLY_ROLES = new Set(['superadmin']);
const ADMIN_MANAGED_ROLES = new Set(['operator', 'readonly']);

function canAssignRole(actorRoles: string[], roleName: string) {
  if (actorRoles.includes('superadmin')) return true;
  return ADMIN_MANAGED_ROLES.has(roleName);
}

async function loadPresentedUser(userId: string) {
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({
    where: { id: userId },
    relations: ['roles', 'roles.role'],
  });
  return user ? presentUser(user) : null;
}

export default async function userRoutes(app: FastifyInstance) {
  const userRepo = AppDataSource.getRepository(User);
  const roleRepo = AppDataSource.getRepository(Role);
  const userRoleRepo = AppDataSource.getRepository(UserRole);
  const authService = new AuthService();
  const auditService = new AuditService();

  app.get('/users', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'users.read'))) return;
    const users = await userRepo.find({ relations: ['roles', 'roles.role'] });
    return reply.send({ users: users.map((user) => presentUser(user)) });
  });

  app.post('/users', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'users.write'))) return;
    const body = parseAndValidate(createUserSchema, request.body, 'create user');
    const actorId = (request as any).user?.sub;
    const actorRoles = await getUserRoles(actorId);
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
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to create user' });
    }
  });

  app.patch('/users/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'users.write'))) return;
    const { id } = request.params as any;
    const body = parseAndValidate(updateUserSchema, request.body, 'update user');
    const actorId = (request as any).user?.sub;
    const actorRoles = await getUserRoles(actorId);

    const target = await userRepo.findOne({ where: { id }, relations: ['roles', 'roles.role'] });
    if (!target) return reply.status(404).send({ error: 'user not found' });

    const targetRoles = (target.roles || [])
      .map((entry) => entry.role?.name)
      .filter((role): role is string => Boolean(role));
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
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error?.message || 'failed to update user' });
    }
  });

  app.post('/users/:id/roles', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'users.write'))) return;
    const { id } = request.params as any;
    const body = parseAndValidate(assignRoleSchema, request.body, 'assign role');
    const actorId = (request as any).user?.sub;
    const actorRoles = await getUserRoles(actorId);

    if (!canAssignRole(actorRoles, body.roleName)) {
      return reply.status(403).send({ error: `not allowed to assign role: ${body.roleName}` });
    }

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

import { AppDataSource } from '../../infrastructure/db/data-source';
import { User } from '../../domain/entities/User';
import { Role } from '../../domain/entities/Role';
import { UserRole } from '../../domain/entities/UserRole';

export async function getUserPermissions(userId: string) {
  const userRoleRepo = AppDataSource.getRepository(UserRole);
  const roles = await userRoleRepo.find({ where: { user: { id: userId } }, relations: ['role', 'role.permissions'] });
  return new Set(roles.flatMap((entry) => entry.role.permissions.map((permission) => permission.code)));
}

export async function userHasPermission(userId: string, permissionCode: string) {
  const permissions = await getUserPermissions(userId);
  return permissions.has(permissionCode);
}

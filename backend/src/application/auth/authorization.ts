import { AppDataSource } from '../../infrastructure/db/data-source';
import { User } from '../../domain/entities/User';
import { Role } from '../../domain/entities/Role';
import { UserRole } from '../../domain/entities/UserRole';

type PermissionCacheEntry = {
  permissions: Set<string>;
  expiresAt: number;
};

const permissionCache = new Map<string, PermissionCacheEntry>();

function getPermissionCacheTtlMs() {
  return Math.max(0, Number(process.env.AUTHZ_CACHE_TTL_MS || 30_000));
}

export async function getUserPermissions(userId: string) {
  const ttlMs = getPermissionCacheTtlMs();
  const cached = permissionCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return new Set(cached.permissions);
  }

  const userRoleRepo = AppDataSource.getRepository(UserRole);
  const roles = await userRoleRepo.find({ where: { user: { id: userId } }, relations: ['role', 'role.permissions'] });
  const permissions = new Set(roles.flatMap((entry) => entry.role.permissions.map((permission) => permission.code)));

  if (ttlMs > 0) {
    permissionCache.set(userId, {
      permissions: new Set(permissions),
      expiresAt: Date.now() + ttlMs,
    });
  }

  return permissions;
}

export async function userHasPermission(userId: string, permissionCode: string) {
  const permissions = await getUserPermissions(userId);
  return permissions.has(permissionCode);
}

export function invalidateUserPermissionCache(userId?: string) {
  if (!userId) {
    permissionCache.clear();
    return;
  }

  permissionCache.delete(userId);
}

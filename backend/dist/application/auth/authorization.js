"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserPermissions = getUserPermissions;
exports.userHasPermission = userHasPermission;
exports.invalidateUserPermissionCache = invalidateUserPermissionCache;
const data_source_1 = require("../../infrastructure/db/data-source");
const UserRole_1 = require("../../domain/entities/UserRole");
const permissionCache = new Map();
function getPermissionCacheTtlMs() {
    return Math.max(0, Number(process.env.AUTHZ_CACHE_TTL_MS || 30000));
}
async function getUserPermissions(userId) {
    const ttlMs = getPermissionCacheTtlMs();
    const cached = permissionCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
        return new Set(cached.permissions);
    }
    const userRoleRepo = data_source_1.AppDataSource.getRepository(UserRole_1.UserRole);
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
async function userHasPermission(userId, permissionCode) {
    const permissions = await getUserPermissions(userId);
    return permissions.has(permissionCode);
}
function invalidateUserPermissionCache(userId) {
    if (!userId) {
        permissionCache.clear();
        return;
    }
    permissionCache.delete(userId);
}

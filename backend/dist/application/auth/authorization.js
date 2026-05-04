"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserPermissions = getUserPermissions;
exports.userHasPermission = userHasPermission;
const data_source_1 = require("../../infrastructure/db/data-source");
const UserRole_1 = require("../../domain/entities/UserRole");
async function getUserPermissions(userId) {
    const userRoleRepo = data_source_1.AppDataSource.getRepository(UserRole_1.UserRole);
    const roles = await userRoleRepo.find({ where: { user: { id: userId } }, relations: ['role', 'role.permissions'] });
    return new Set(roles.flatMap((entry) => entry.role.permissions.map((permission) => permission.code)));
}
async function userHasPermission(userId, permissionCode) {
    const permissions = await getUserPermissions(userId);
    return permissions.has(permissionCode);
}

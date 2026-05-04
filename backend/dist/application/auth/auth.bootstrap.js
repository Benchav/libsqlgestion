"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapSecurityCatalog = bootstrapSecurityCatalog;
const data_source_1 = require("../../infrastructure/db/data-source");
const Permission_1 = require("../../domain/entities/Permission");
const Role_1 = require("../../domain/entities/Role");
const typeorm_1 = require("typeorm");
const CORE_PERMISSIONS = [
    { code: 'users.read', description: 'List users' },
    { code: 'users.write', description: 'Manage users' },
    { code: 'projects.read', description: 'List projects' },
    { code: 'projects.write', description: 'Manage projects' },
    { code: 'databases.read', description: 'List databases' },
    { code: 'databases.write', description: 'Manage databases' },
    { code: 'audit.read', description: 'Read audit log' },
];
const ROLE_MATRIX = [
    { name: 'superadmin', permissions: CORE_PERMISSIONS.map((permission) => permission.code) },
    { name: 'admin', permissions: ['projects.read', 'projects.write', 'databases.read', 'databases.write', 'audit.read'] },
    { name: 'operator', permissions: ['projects.read', 'databases.read', 'databases.write'] },
    { name: 'readonly', permissions: ['projects.read', 'databases.read', 'audit.read'] },
];
async function bootstrapSecurityCatalog() {
    const permissionRepo = data_source_1.AppDataSource.getRepository(Permission_1.Permission);
    const roleRepo = data_source_1.AppDataSource.getRepository(Role_1.Role);
    for (const permission of CORE_PERMISSIONS) {
        const exists = await permissionRepo.findOneBy({ code: permission.code });
        if (!exists) {
            await permissionRepo.save(permissionRepo.create(permission));
        }
    }
    for (const roleConfig of ROLE_MATRIX) {
        const role = await roleRepo.findOne({ where: { name: roleConfig.name }, relations: ['permissions'] });
        const permissions = await permissionRepo.find({ where: { code: (0, typeorm_1.In)(roleConfig.permissions) } });
        if (!role) {
            await roleRepo.save(roleRepo.create({ name: roleConfig.name, isSystem: true, permissions }));
            continue;
        }
        role.permissions = permissions;
        await roleRepo.save(role);
    }
}

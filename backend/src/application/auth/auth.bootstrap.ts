import { AppDataSource } from '../../infrastructure/db/data-source';
import { Permission } from '../../domain/entities/Permission';
import { Role } from '../../domain/entities/Role';
import { In } from 'typeorm';

const CORE_PERMISSIONS = [
  { code: 'users.read', description: 'List users' },
  { code: 'users.write', description: 'Manage users' },
  { code: 'projects.read', description: 'List projects' },
  { code: 'projects.write', description: 'Manage projects' },
  { code: 'databases.read', description: 'List databases' },
  { code: 'databases.write', description: 'Manage databases' },
  { code: 'settings.read', description: 'View platform settings' },
  { code: 'settings.write', description: 'Manage platform settings' },
  { code: 'audit.read', description: 'Read audit log' },
];

const ROLE_MATRIX = [
  { name: 'superadmin', permissions: CORE_PERMISSIONS.map((permission) => permission.code) },
  { name: 'admin', permissions: ['projects.read', 'projects.write', 'databases.read', 'databases.write', 'settings.read', 'settings.write', 'audit.read'] },
  { name: 'operator', permissions: ['projects.read', 'databases.read', 'databases.write'] },
  { name: 'readonly', permissions: ['projects.read', 'databases.read', 'audit.read'] },
];

export async function bootstrapSecurityCatalog() {
  const permissionRepo = AppDataSource.getRepository(Permission);
  const roleRepo = AppDataSource.getRepository(Role);

  for (const permission of CORE_PERMISSIONS) {
    const exists = await permissionRepo.findOneBy({ code: permission.code });
    if (!exists) {
      await permissionRepo.save(permissionRepo.create(permission));
    }
  }

  for (const roleConfig of ROLE_MATRIX) {
    const role = await roleRepo.findOne({ where: { name: roleConfig.name }, relations: ['permissions'] });
    const permissions = await permissionRepo.find({ where: { code: In(roleConfig.permissions) } });
    if (!role) {
      await roleRepo.save(roleRepo.create({ name: roleConfig.name, isSystem: true, permissions }));
      continue;
    }
    role.permissions = permissions;
    await roleRepo.save(role);
  }
}

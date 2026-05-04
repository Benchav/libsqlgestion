import { DataSource } from 'typeorm';
import { User } from '../../domain/entities/User';
import { Project } from '../../domain/entities/Project';
import { Database } from '../../domain/entities/Database';
import { Role } from '../../domain/entities/Role';
import { Permission } from '../../domain/entities/Permission';
import { UserRole } from '../../domain/entities/UserRole';
import { AuditLog } from '../../domain/entities/AuditLog';
import { Session } from '../../domain/entities/Session';
import { ProjectMember } from '../../domain/entities/ProjectMember';

const databaseFile = process.env.DATABASE_FILE || './data/control.db';

export const AppDataSource = new DataSource({
  type: 'sqlite',
  database: databaseFile,
  synchronize: true,
  logging: false,
  entities: [User, Project, Database, Role, Permission, UserRole, AuditLog, Session, ProjectMember],
});

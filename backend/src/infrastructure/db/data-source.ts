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
import { DatabaseMigration } from '../../domain/entities/DatabaseMigration';
import { PlatformSetting } from '../../domain/entities/PlatformSetting';
import { DatabaseSnapshot } from '../../domain/entities/DatabaseSnapshot';
import { DatabaseSnapshotPolicy } from '../../domain/entities/DatabaseSnapshotPolicy';
import { QueryMetric } from '../../domain/entities/QueryMetric';
import { TrafficMetric } from '../../domain/entities/TrafficMetric';
import { StorageSample } from '../../domain/entities/StorageSample';
import { InitialControlPlane1710000000000 } from '../../migrations/1710000000000-InitialControlPlane';
import { PlatformSettings1710000001000 } from '../../migrations/1710000001000-PlatformSettings';
import { DatabaseSnapshots1710000002000 } from '../../migrations/1710000002000-DatabaseSnapshots';
import { DatabaseSnapshotPolicies1710000003000 } from '../../migrations/1710000003000-DatabaseSnapshotPolicies';
import { Analytics1710000004000 } from '../../migrations/1710000004000-Analytics';
import { DatabaseProtection1710000005000 } from '../../migrations/1710000005000-DatabaseProtection';

const databaseFile = process.env.DATABASE_FILE || './data/control.db';

export const AppDataSource = new DataSource({
  type: 'sqlite',
  database: databaseFile,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [User, Project, Database, Role, Permission, UserRole, AuditLog, Session, ProjectMember, DatabaseMigration, PlatformSetting, DatabaseSnapshot, DatabaseSnapshotPolicy, QueryMetric, TrafficMetric, StorageSample],
  migrations: [InitialControlPlane1710000000000, PlatformSettings1710000001000, DatabaseSnapshots1710000002000, DatabaseSnapshotPolicies1710000003000, Analytics1710000004000, DatabaseProtection1710000005000],
});

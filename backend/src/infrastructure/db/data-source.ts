import { DataSource } from 'typeorm';
import { User } from '../../domain/entities/User';
import { Project } from '../../domain/entities/Project';
import { Database } from '../../domain/entities/Database';

const databaseFile = process.env.DATABASE_FILE || './data/control.db';

export const AppDataSource = new DataSource({
  type: 'sqlite',
  database: databaseFile,
  synchronize: true,
  logging: false,
  entities: [User, Project, Database],
});

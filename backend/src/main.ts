import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();
import { AppDataSource } from './infrastructure/db/data-source';
import { buildServer } from './server';
import { bootstrapSecurityCatalog } from './application/auth/auth.bootstrap';

const start = async () => {
  await AppDataSource.initialize();
  await bootstrapSecurityCatalog();
  const app = buildServer();
  try {
    await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
    console.log('Server started on port', process.env.PORT || 3000);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

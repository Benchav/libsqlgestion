import { FastifyInstance } from 'fastify';
import authRoutes from './controllers/AuthController';
import projectRoutes from './controllers/ProjectController';
import databaseRoutes from './controllers/DatabaseController';
import auditRoutes from './controllers/AuditController';
import userRoutes from './controllers/UserController';
import schemaRoutes from './controllers/SchemaController';
import queryRoutes from './controllers/QueryController';
import provisioningRoutes from './controllers/ProvisioningController';
import healthRoutes from './controllers/HealthController';

export default async function routes(app: FastifyInstance) {
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(projectRoutes);
  app.register(databaseRoutes);
  app.register(auditRoutes);
  app.register(userRoutes);
  app.register(schemaRoutes);
  app.register(queryRoutes);
  app.register(provisioningRoutes);
}

import { FastifyInstance } from 'fastify';
import authRoutes from './controllers/AuthController';

export default async function routes(app: FastifyInstance) {
  app.register(authRoutes);
}

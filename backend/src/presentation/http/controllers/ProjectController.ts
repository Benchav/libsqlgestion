import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProjectService } from '../../../application/projects/ProjectService';
import { AppDataSource } from '../../../infrastructure/db/data-source';
import { User } from '../../../domain/entities/User';
import { ensurePermission, ensureProjectAccess } from '../guards';
import { AuditService } from '../../../application/audit/AuditService';

export default async function projectRoutes(app: FastifyInstance) {
  const projectService = new ProjectService();
  const auditService = new AuditService();

  app.get('/projects', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'projects.read'))) return;
    const user = (request as any).user;
    const projects = await projectService.listProjects(user?.sub);
    return reply.send({ projects });
  });

  app.post('/projects', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'projects.write'))) return;
    const body = request.body as any;
    if (!body.name) return reply.status(400).send({ error: 'name required' });

    const userId = (request as any).user?.sub;
    const userRepo = AppDataSource.getRepository(User);
    const owner = await userRepo.findOneBy({ id: userId });
    if (!owner) return reply.status(404).send({ error: 'owner not found' });

    const project = await projectService.createProject(owner, body.name);
    await auditService.record({ action: 'project.create', resourceType: 'project', resourceId: project.id, actorId: userId });
    return reply.status(201).send({ project });
  });

  app.get('/projects/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'projects.read'))) return;
    const { id } = request.params as any;
    const access = await ensureProjectAccess(request, reply, id);
    if (!access) return;
    const project = await projectService.getProject(id);
    if (!project) return reply.status(404).send({ error: 'project not found' });
    return reply.send({ project });
  });

  app.delete('/projects/:id', { preHandler: [app.authenticate as any] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensurePermission(request, reply, 'projects.write'))) return;
    const { id } = request.params as any;
    const access = await ensureProjectAccess(request, reply, id);
    if (!access) return;
    try {
      const result = await projectService.deleteProject(id);
      const userId = (request as any).user?.sub;
      await auditService.record({ action: 'project.delete', resourceType: 'project', resourceId: id, actorId: userId });
      return reply.send(result);
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });
}

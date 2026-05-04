import { FastifyReply, FastifyRequest } from 'fastify';
import { userHasPermission } from '../../application/auth/authorization';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Project } from '../../domain/entities/Project';
import { Database } from '../../domain/entities/Database';

export async function ensurePermission(request: FastifyRequest, reply: FastifyReply, permission: string) {
  const user = (request as any).user;
  if (!user?.sub) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }

  const allowed = await userHasPermission(user.sub, permission);
  if (!allowed) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  return true;
}

export async function ensureProjectAccess(request: FastifyRequest, reply: FastifyReply, projectId: string) {
  const user = (request as any).user;
  if (!user?.sub) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }

  const project = await AppDataSource.getRepository(Project).findOne({
    where: { id: projectId },
    relations: ['owner', 'members', 'members.user'],
  });

  if (!project) {
    reply.code(404).send({ error: 'project not found' });
    return null;
  }

  const isOwner = project.owner?.id === user.sub;
  const isMember = project.members?.some((member) => member.user?.id === user.sub);
  if (!isOwner && !isMember) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }

  return project;
}

export async function ensureDatabaseAccess(request: FastifyRequest, reply: FastifyReply, databaseId: string) {
  const user = (request as any).user;
  if (!user?.sub) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }

  const database = await AppDataSource.getRepository(Database).findOne({
    where: { id: databaseId },
    relations: ['project', 'project.owner', 'project.members', 'project.members.user'],
  });

  if (!database) {
    reply.code(404).send({ error: 'database not found' });
    return null;
  }

  const project = database.project;
  const isOwner = project?.owner?.id === user.sub;
  const isMember = project?.members?.some((member) => member.user?.id === user.sub);
  if (!isOwner && !isMember) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }

  return database;
}

import { FastifyReply, FastifyRequest } from 'fastify';
import { userHasPermission } from '../../application/auth/authorization';

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

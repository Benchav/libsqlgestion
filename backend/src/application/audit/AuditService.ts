import { AppDataSource } from '../../infrastructure/db/data-source';
import { AuditLog } from '../../domain/entities/AuditLog';

export class AuditService {
  private auditRepo = AppDataSource.getRepository(AuditLog);

  async record(input: { action: string; resourceType?: string; resourceId?: string; metadata?: Record<string, unknown>; ipAddress?: string; actorId?: string }) {
    const log = this.auditRepo.create({
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata,
      ipAddress: input.ipAddress,
      actor: input.actorId ? ({ id: input.actorId } as any) : undefined,
    });
    return this.auditRepo.save(log);
  }

  list() {
  async list(input: { page?: number; limit?: number; search?: string } = {}) {
    const page = Math.max(1, Math.floor(input.page || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit || 50)));
    const skip = (page - 1) * limit;
    const search = input.search?.trim();

    const query = this.auditRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.actor', 'actor')
      .orderBy('audit.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (search) {
      const term = `%${search.toLowerCase()}%`;
      query.andWhere(
        '(LOWER(audit.action) LIKE :term OR LOWER(COALESCE(audit.resourceType, \'\')) LIKE :term OR LOWER(COALESCE(audit.resourceId, \'\')) LIKE :term OR LOWER(COALESCE(actor.email, \'\')) LIKE :term)',
        { term },
      );
    }

    const [logs, total] = await query.getManyAndCount();
    return {
      logs,
      total,
      page,
      limit,
      hasMore: skip + logs.length < total,
    };
}

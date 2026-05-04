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
    return this.auditRepo.find({ relations: ['actor'], order: { createdAt: 'DESC' } });
  }
}

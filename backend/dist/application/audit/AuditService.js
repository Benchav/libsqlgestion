"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const AuditLog_1 = require("../../domain/entities/AuditLog");
class AuditService {
    constructor() {
        this.auditRepo = data_source_1.AppDataSource.getRepository(AuditLog_1.AuditLog);
    }
    async record(input) {
        const log = this.auditRepo.create({
            action: input.action,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            metadata: input.metadata,
            ipAddress: input.ipAddress,
            actor: input.actorId ? { id: input.actorId } : undefined,
        });
        return this.auditRepo.save(log);
    }
    async list(input = {}) {
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
            query.andWhere('(LOWER(audit.action) LIKE :term OR LOWER(COALESCE(audit.resourceType, \'\')) LIKE :term OR LOWER(COALESCE(audit.resourceId, \'\')) LIKE :term OR LOWER(COALESCE(actor.email, \'\')) LIKE :term)', { term });
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
}
exports.AuditService = AuditService;

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
    list() {
        return this.auditRepo.find({ relations: ['actor'], order: { createdAt: 'DESC' } });
    }
}
exports.AuditService = AuditService;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const Project_1 = require("../../domain/entities/Project");
const crypto_1 = require("../../infrastructure/crypto");
const tokens_1 = require("../../infrastructure/security/tokens");
const AuditService_1 = require("../audit/AuditService");
class DatabaseService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.projectRepo = data_source_1.AppDataSource.getRepository(Project_1.Project);
        this.auditService = new AuditService_1.AuditService();
    }
    async createDatabase(projectId, input) {
        const project = await this.projectRepo.findOneByOrFail({ id: projectId });
        const token = input.token ?? (0, tokens_1.randomToken)();
        const encryptedToken = (0, crypto_1.encrypt)(token);
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: input.name,
            type: input.type,
            url: input.url,
            encryptedToken,
            subdomain: input.subdomain,
            status: 'inactive',
            metadata: input.metadata,
            project,
        }));
        if (input.type === 'sqlite') {
            const filePath = this.resolveSqlitePath(database.id);
            fs_1.default.mkdirSync(path_1.default.dirname(filePath), { recursive: true });
            if (!fs_1.default.existsSync(filePath))
                fs_1.default.writeFileSync(filePath, Buffer.from(''));
            database.url = filePath;
            database.status = 'active';
            await this.databaseRepo.save(database);
        }
        await this.auditService.record({
            action: 'database.create',
            resourceType: 'database',
            resourceId: database.id,
            metadata: { projectId, type: input.type, subdomain: input.subdomain },
        });
        return { database, token };
    }
    async listDatabases(projectId) {
        if (!projectId)
            return this.databaseRepo.find({ relations: ['project', 'project.owner'] });
        return this.databaseRepo.find({ where: { project: { id: projectId } }, relations: ['project', 'project.owner'] });
    }
    async getDatabase(id) {
        return this.databaseRepo.findOne({ where: { id }, relations: ['project', 'project.owner'] });
    }
    async rotateToken(id) {
        const database = await this.databaseRepo.findOneByOrFail({ id });
        const newToken = (0, tokens_1.randomToken)();
        database.encryptedToken = (0, crypto_1.encrypt)(newToken);
        await this.databaseRepo.save(database);
        await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
        return { database, token: newToken };
    }
    async testConnection(id) {
        const database = await this.databaseRepo.findOneByOrFail({ id });
        if (database.type === 'sqlite') {
            const url = database.url || this.resolveSqlitePath(database.id);
            const ok = fs_1.default.existsSync(url);
            return { ok, details: ok ? 'sqlite file exists' : 'sqlite file missing' };
        }
        if (!database.encryptedToken)
            return { ok: false, details: 'missing token' };
        const token = (0, crypto_1.decrypt)(database.encryptedToken);
        return { ok: Boolean(database.url && token.length > 0), details: 'remote/libsql validation deferred to integration layer' };
    }
    resolveSqlitePath(databaseId) {
        return path_1.default.join(process.cwd(), 'data', 'sqlite', `${databaseId}.db`);
    }
}
exports.DatabaseService = DatabaseService;

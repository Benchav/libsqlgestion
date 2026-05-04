"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const fs_2 = require("fs");
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const Project_1 = require("../../domain/entities/Project");
const crypto_1 = require("../../infrastructure/crypto");
const tokens_1 = require("../../infrastructure/security/tokens");
const AuditService_1 = require("../audit/AuditService");
const LibsqlClient_1 = require("../../infrastructure/libsql/LibsqlClient");
const slug_1 = require("../../infrastructure/security/slug");
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
        const subdomain = input.subdomain ?? (0, slug_1.ensureSubdomain)(input.name, (0, tokens_1.randomToken)());
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: input.name,
            type: input.type,
            url: input.url,
            encryptedToken,
            subdomain,
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
        else if (input.url) {
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
    async importExistingSqlite(projectId, input) {
        const project = await this.projectRepo.findOneByOrFail({ id: projectId });
        if (!fs_1.default.existsSync(input.sourcePath)) {
            throw new Error('sourcePath does not exist');
        }
        const subdomain = input.subdomain ?? (0, slug_1.ensureSubdomain)(input.name, (0, tokens_1.randomToken)());
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: input.name,
            type: 'sqlite',
            status: 'inactive',
            subdomain,
            metadata: { ...(input.metadata ?? {}), imported: true, sourcePath: input.sourcePath },
            project,
        }));
        const managedPath = this.resolveSqlitePath(database.id);
        fs_1.default.mkdirSync(path_1.default.dirname(managedPath), { recursive: true });
        await fs_2.promises.copyFile(input.sourcePath, managedPath);
        database.url = managedPath;
        database.status = 'active';
        database.encryptedToken = (0, crypto_1.encrypt)(input.token ?? (0, tokens_1.randomToken)());
        await this.databaseRepo.save(database);
        await this.auditService.record({
            action: 'database.import',
            resourceType: 'database',
            resourceId: database.id,
            metadata: { projectId, sourcePath: input.sourcePath, subdomain: input.subdomain },
        });
        return { database };
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
        if (!database.url || !database.encryptedToken)
            return { ok: false, details: 'missing url or token' };
        const token = (0, crypto_1.decrypt)(database.encryptedToken);
        const client = (0, LibsqlClient_1.createLibsqlClient)(database.url, token);
        try {
            await client.execute('SELECT 1');
            return { ok: true, details: 'connection ok' };
        }
        catch (error) {
            return { ok: false, details: error.message };
        }
        finally {
            client.close();
        }
    }
    resolveSqlitePath(databaseId) {
        return path_1.default.join(process.cwd(), 'data', 'sqlite', `${databaseId}.db`);
    }
}
exports.DatabaseService = DatabaseService;

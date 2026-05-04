"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscoveryService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const Project_1 = require("../../domain/entities/Project");
const crypto_1 = require("../../infrastructure/crypto");
const tokens_1 = require("../../infrastructure/security/tokens");
const slug_1 = require("../../infrastructure/security/slug");
const AuditService_1 = require("../audit/AuditService");
const SqliteStorageService_1 = require("../../infrastructure/storage/SqliteStorageService");
class DiscoveryService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.projectRepo = data_source_1.AppDataSource.getRepository(Project_1.Project);
        this.auditService = new AuditService_1.AuditService();
        this.storageService = new SqliteStorageService_1.SqliteStorageService();
    }
    async scanMountedDirectory(projectId, rootPath, adopt = false) {
        const baseDir = rootPath || process.env.SQLITE_DISCOVERY_PATH;
        if (!baseDir) {
            throw new Error('SQLITE_DISCOVERY_PATH not configured');
        }
        const project = await this.projectRepo.findOneByOrFail({ id: projectId });
        const files = this.collectSqliteFiles(baseDir);
        const discovered = [];
        for (const filePath of files) {
            const existing = await this.databaseRepo.findOne({ where: { url: filePath }, relations: ['project'] });
            if (existing) {
                discovered.push(existing);
                continue;
            }
            const fileName = path_1.default.basename(filePath, path_1.default.extname(filePath));
            const database = await this.databaseRepo.save(this.databaseRepo.create({
                name: fileName,
                type: 'sqlite',
                url: filePath,
                encryptedToken: (0, crypto_1.encrypt)((0, tokens_1.randomToken)()),
                subdomain: (0, slug_1.ensureSubdomain)(fileName, path_1.default.parse(filePath).name),
                status: 'active',
                metadata: { sourcePath: filePath, discovered: true, mountedDirectory: baseDir, adopted: adopt },
                project,
            }));
            if (adopt) {
                const managedPath = await this.storageService.adoptExistingFile(filePath, project.id, database.id);
                database.url = managedPath;
                database.metadata = { ...(database.metadata ?? {}), managedPath, adopted: true };
                await this.databaseRepo.save(database);
            }
            discovered.push(database);
            await this.auditService.record({
                action: 'database.discovered',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { filePath, baseDir, adopted: adopt },
            });
        }
        return { discovered, count: discovered.length, baseDir };
    }
    collectSqliteFiles(rootPath) {
        const results = [];
        const visit = (currentPath) => {
            if (!fs_1.default.existsSync(currentPath))
                return;
            const stat = fs_1.default.statSync(currentPath);
            if (stat.isDirectory()) {
                for (const entry of fs_1.default.readdirSync(currentPath)) {
                    visit(path_1.default.join(currentPath, entry));
                }
                return;
            }
            if (/\.db$/i.test(currentPath)) {
                results.push(currentPath);
            }
        };
        visit(rootPath);
        return results;
    }
}
exports.DiscoveryService = DiscoveryService;

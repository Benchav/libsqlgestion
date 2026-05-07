"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteStorageService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const fs_2 = require("fs");
class SqliteStorageService {
    constructor(storageRoot) {
        this.storageRoot = storageRoot || process.env.SQLITE_STORAGE_ROOT || path_1.default.join(process.cwd(), 'data', 'sqlite');
    }
    managedDatabasePath(projectId, databaseId) {
        return path_1.default.join(this.storageRoot, 'projects', projectId, 'databases', `${databaseId}.db`);
    }
    managedProjectDirectory(projectId) {
        return path_1.default.join(this.storageRoot, 'projects', projectId, 'databases');
    }
    async ensureManagedDatabaseFile(projectId, databaseId) {
        const filePath = this.managedDatabasePath(projectId, databaseId);
        fs_1.default.mkdirSync(path_1.default.dirname(filePath), { recursive: true });
        // Do NOT create an empty file — sqld will create a valid SQLite database
        // on first start if the file doesn't exist. A 0-byte file would be treated
        // as corrupt and cause the container to crash.
        return filePath;
    }
    async importDatabaseFile(sourcePath, projectId, databaseId) {
        const targetPath = this.managedDatabasePath(projectId, databaseId);
        fs_1.default.mkdirSync(path_1.default.dirname(targetPath), { recursive: true });
        await fs_2.promises.copyFile(sourcePath, targetPath);
        return targetPath;
    }
    async adoptExistingFile(sourcePath, projectId, databaseId) {
        return this.importDatabaseFile(sourcePath, projectId, databaseId);
    }
    isManagedPath(filePath) {
        const normalizedRoot = path_1.default.normalize(this.storageRoot) + path_1.default.sep;
        const normalizedPath = path_1.default.normalize(filePath);
        return normalizedPath.startsWith(normalizedRoot);
    }
}
exports.SqliteStorageService = SqliteStorageService;

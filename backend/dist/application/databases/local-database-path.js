"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLocalDatabasePath = resolveLocalDatabasePath;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Resolves the on-disk path of a LOCAL-FILE SQLite database.
 *
 * The resolver intentionally mirrors the historical ConnectionPool behaviour,
 * but can be used in read-only mode (createIfMissing=false) by snapshots and
 * other maintenance tasks so they never create empty database files.
 */
function resolveLocalDatabasePath(database, options = {}) {
    const storageRoot = options.storageRoot || process.env.SQLITE_STORAGE_ROOT || path_1.default.join(process.cwd(), 'data', 'sqlite');
    const createIfMissing = options.createIfMissing === true;
    let filePath = database.url || '';
    // 1. Direct path exists.
    if (!filePath || !fs_1.default.existsSync(filePath)) {
        // 2. If database.url contains 'projects/...', re-base onto current storageRoot.
        if (filePath && filePath.includes('projects')) {
            const relativeSub = filePath.substring(filePath.indexOf('projects'));
            const candidate = path_1.default.join(storageRoot, relativeSub);
            if (fs_1.default.existsSync(candidate)) {
                filePath = candidate;
            }
        }
    }
    // 3. Try standard managed paths if project id is available.
    if (!filePath || !fs_1.default.existsSync(filePath)) {
        if (database.project?.id) {
            const flatDb = path_1.default.join(storageRoot, 'projects', database.project.id, 'databases', `${database.id}.db`);
            const nestedData = path_1.default.join(storageRoot, 'projects', database.project.id, 'databases', database.id, 'dbs', 'default', 'data');
            if (fs_1.default.existsSync(flatDb)) {
                filePath = flatDb;
            }
            else if (fs_1.default.existsSync(nestedData)) {
                filePath = nestedData;
            }
        }
    }
    // 4. Scan projects directory in storageRoot for any matching database id file.
    if (!filePath || !fs_1.default.existsSync(filePath)) {
        try {
            const projectsDir = path_1.default.join(storageRoot, 'projects');
            if (fs_1.default.existsSync(projectsDir)) {
                for (const projectDir of fs_1.default.readdirSync(projectsDir)) {
                    const flatCandidate = path_1.default.join(projectsDir, projectDir, 'databases', `${database.id}.db`);
                    const nestedCandidate = path_1.default.join(projectsDir, projectDir, 'databases', database.id, 'dbs', 'default', 'data');
                    if (fs_1.default.existsSync(flatCandidate)) {
                        filePath = flatCandidate;
                        break;
                    }
                    if (fs_1.default.existsSync(nestedCandidate)) {
                        filePath = nestedCandidate;
                        break;
                    }
                }
            }
        }
        catch {
            // Ignore scanning errors; the caller decides what to do with a missing file.
        }
    }
    if (filePath && fs_1.default.existsSync(filePath)) {
        return filePath;
    }
    if (!createIfMissing) {
        return null;
    }
    // 5. Legacy behaviour: initialize an empty SQLite database if the record exists.
    const projectId = database.project?.id || 'default';
    filePath = path_1.default.join(storageRoot, 'projects', projectId, 'databases', `${database.id}.db`);
    fs_1.default.mkdirSync(path_1.default.dirname(filePath), { recursive: true });
    if (!fs_1.default.existsSync(filePath)) {
        fs_1.default.writeFileSync(filePath, Buffer.from(''));
    }
    return filePath;
}

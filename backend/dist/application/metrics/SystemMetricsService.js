"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SystemMetricsService = void 0;
const fs_1 = __importDefault(require("fs"));
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const LibsqlRuntimeService_1 = require("../../infrastructure/docker/LibsqlRuntimeService");
const ConnectionPool_1 = require("../../infrastructure/db/ConnectionPool");
const os_1 = __importDefault(require("os"));
class SystemMetricsService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.runtimeService = new LibsqlRuntimeService_1.LibsqlRuntimeService();
    }
    async getMetrics() {
        const databases = await this.databaseRepo.find();
        const pool = ConnectionPool_1.ConnectionPool.getInstance();
        let totalDiskBytes = 0;
        // Node.js base memory usage (RSS)
        let totalRamBytes = process.memoryUsage().rss;
        const metrics = [];
        let publicRuntimeCount = 0;
        let healthyPublicRuntimeCount = 0;
        let unhealthyPublicRuntimeCount = 0;
        let provisioningCount = 0;
        let errorCount = 0;
        for (const db of databases) {
            let diskBytes = 0;
            let ramBytes = 0;
            let isRamEstimated = false;
            // 1. Calculate Disk Usage
            const fileCandidates = new Set();
            if (db.type === 'sqlite' && db.url) {
                fileCandidates.add(db.url);
            }
            const runtimeMetadata = db.metadata?.runtime;
            const runtimeHealth = runtimeMetadata?.routeHealth && typeof runtimeMetadata.routeHealth === 'object'
                ? {
                    internalOk: Boolean(runtimeMetadata.routeHealth.internalOk),
                    backendOk: Boolean(runtimeMetadata.routeHealth.backendOk),
                    publicOk: Boolean(runtimeMetadata.routeHealth.publicOk),
                    publicChecked: Boolean(runtimeMetadata.routeHealth.publicChecked),
                }
                : null;
            if (db.status === 'provisioning')
                provisioningCount += 1;
            if (db.status === 'error')
                errorCount += 1;
            if (runtimeMetadata?.provider === 'docker-libsql') {
                publicRuntimeCount += 1;
                if (runtimeHealth?.internalOk && runtimeHealth?.backendOk && (!runtimeHealth.publicChecked || runtimeHealth.publicOk)) {
                    healthyPublicRuntimeCount += 1;
                }
                else {
                    unhealthyPublicRuntimeCount += 1;
                }
            }
            if (runtimeMetadata?.provider === 'docker-libsql' && runtimeMetadata.databasePath) {
                fileCandidates.add(runtimeMetadata.databasePath);
            }
            for (const filePath of fileCandidates) {
                diskBytes += this.getFileSizeSafe(filePath);
                diskBytes += this.getFileSizeSafe(`${filePath}-wal`);
                diskBytes += this.getFileSizeSafe(`${filePath}-shm`);
            }
            // 2. Calculate RAM Usage
            if (db.type === 'sqlite') {
                isRamEstimated = true;
                // If it's active in the pool, we estimate ~20MB for the PRAGMA cache + SQLite structures
                // If not, we estimate 0MB. The memory is shared in the Node process anyway.
                if (pool.pool.has(db.id)) {
                    ramBytes = 25 * 1024 * 1024; // 25MB estimate
                }
                else {
                    ramBytes = 0;
                }
            }
            else {
                // LibSQL Docker container
                isRamEstimated = false;
                if (runtimeMetadata?.containerId) {
                    const stats = await this.runtimeService.getContainerStats(runtimeMetadata.containerId);
                    ramBytes = stats.memoryBytes;
                    totalRamBytes += ramBytes; // Add container memory to total server memory
                }
            }
            totalDiskBytes += diskBytes;
            metrics.push({
                id: db.id,
                name: db.name,
                type: db.type,
                status: db.status,
                diskBytes,
                ramBytes,
                isRamEstimated,
                runtimeProvider: typeof runtimeMetadata?.provider === 'string' ? runtimeMetadata.provider : undefined,
                runtimeHealth,
            });
        }
        // Sort by largest disk/ram
        metrics.sort((a, b) => b.ramBytes - a.ramBytes || b.diskBytes - a.diskBytes);
        const maxRamBytes = os_1.default.totalmem();
        // Rough estimate of CPU load % over the last 1 minute on the server
        const cpus = os_1.default.cpus().length;
        const cpuUsagePercent = Math.min(100, Math.max(0, (os_1.default.loadavg()[0] / cpus) * 100));
        return {
            totalDiskBytes,
            totalRamBytes,
            maxRamBytes,
            cpuUsagePercent,
            runtimeSummary: {
                publicRuntimeCount,
                healthyPublicRuntimeCount,
                unhealthyPublicRuntimeCount,
                provisioningCount,
                errorCount,
            },
            pool: pool.stats,
            databases: metrics,
        };
    }
    getFileSizeSafe(filePath) {
        try {
            if (fs_1.default.existsSync(filePath)) {
                const stat = fs_1.default.statSync(filePath);
                return stat.size;
            }
        }
        catch {
            // Ignore
        }
        return 0;
    }
}
exports.SystemMetricsService = SystemMetricsService;

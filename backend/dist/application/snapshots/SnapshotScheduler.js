"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotScheduler = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const snapshot_config_1 = require("./snapshot-config");
const SnapshotService_1 = require("./SnapshotService");
class SnapshotScheduler {
    constructor(service = new SnapshotService_1.SnapshotService()) {
        this.service = service;
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.timer = null;
        this.stopped = true;
        this.running = null;
        this.failures = new Map();
    }
    start() {
        if (!(0, snapshot_config_1.getSnapshotConfig)().enabled || this.timer)
            return;
        this.stopped = false;
        this.schedule((0, snapshot_config_1.getSnapshotConfig)().initialDelayMs);
        console.log(`[snapshots] scheduler enabled (every ${(0, snapshot_config_1.getSnapshotConfig)().intervalMinutes} min)`);
    }
    async stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.running) {
            await Promise.race([
                this.running,
                new Promise((resolve) => setTimeout(resolve, 60000)),
            ]);
        }
    }
    async runOnce(now = new Date()) {
        const config = (0, snapshot_config_1.getSnapshotConfig)();
        if (!config.enabled)
            return { scanned: 0, created: 0 };
        await this.service.cleanupOrphans();
        const databases = await this.databaseRepo.find({ relations: ['project'] });
        let scanned = 0;
        let created = 0;
        for (const database of databases) {
            if (!['active', 'inactive'].includes(database.status))
                continue;
            if (!this.service.supportsDatabase(database))
                continue;
            scanned += 1;
            const state = await this.service.getSchedulerState(database.id);
            if (state.pending)
                continue;
            const failure = this.failures.get(database.id);
            if (failure && failure.retryAt > now.getTime())
                continue;
            if (state.latest?.status === 'ready') {
                const ageMs = now.getTime() - new Date(state.latest.takenAt).getTime();
                if (ageMs < config.intervalMinutes * 60 * 1000)
                    continue;
            }
            try {
                await this.service.createSnapshot(database.id, {
                    reason: 'scheduled',
                    pinned: false,
                });
                this.failures.delete(database.id);
                created += 1;
            }
            catch (error) {
                const attempts = (failure?.attempts || 0) + 1;
                const backoffMinutes = Math.min(30, 5 * 2 ** (attempts - 1));
                this.failures.set(database.id, {
                    attempts,
                    retryAt: now.getTime() + backoffMinutes * 60 * 1000,
                });
                console.warn(`[snapshots] failed for ${database.name} (${database.id}); retrying in ${backoffMinutes} min:`, error?.message || error);
            }
        }
        return { scanned, created };
    }
    schedule(delayMs) {
        if (this.stopped)
            return;
        this.timer = setTimeout(() => {
            void this.tick();
        }, Math.max(1000, delayMs));
        this.timer.unref?.();
    }
    async tick() {
        if (this.stopped)
            return;
        if (this.running)
            return;
        this.running = this.runOnce();
        try {
            await this.running;
        }
        catch (error) {
            console.warn('[snapshots] scheduler run failed:', error?.message || error);
        }
        finally {
            this.running = null;
            if (!this.stopped) {
                this.schedule((0, snapshot_config_1.getSnapshotConfig)().intervalMinutes * 60 * 1000);
            }
        }
    }
}
exports.SnapshotScheduler = SnapshotScheduler;

import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { getSnapshotConfig } from './snapshot-config';
import { SnapshotService } from './SnapshotService';

type FailureState = {
  attempts: number;
  retryAt: number;
};

export class SnapshotScheduler {
  private databaseRepo = AppDataSource.getRepository(Database);
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running: Promise<unknown> | null = null;
  private failures = new Map<string, FailureState>();

  constructor(private readonly service = new SnapshotService()) {}

  async start() {
    if (!getSnapshotConfig().enabled || this.timer) return;
    this.stopped = false;
    try {
      await this.service.recoverInterruptedSnapshots();
    } catch (error: any) {
      console.warn('[snapshots] could not recover interrupted snapshots:', error?.message || error);
    }
    this.schedule(getSnapshotConfig().initialDelayMs);
    console.log(`[snapshots] scheduler enabled (every ${getSnapshotConfig().intervalMinutes} min)`);
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
        new Promise<void>((resolve) => setTimeout(resolve, 60_000)),
      ]);
    }
  }

  async runOnce(now = new Date()) {
    const config = getSnapshotConfig();
    if (!config.enabled) return { scanned: 0, created: 0 };

    await this.service.cleanupOrphans();

    const databases = await this.databaseRepo.find({ relations: ['project'] });
    let scanned = 0;
    let created = 0;

    for (const database of databases) {
      if (!['active', 'inactive'].includes(database.status)) continue;
      if (!this.service.supportsDatabase(database)) continue;

      scanned += 1;

      const state = await this.service.getSchedulerState(database.id);
      if (state.pending) continue;

      const failure = this.failures.get(database.id);
      if (failure && failure.retryAt > now.getTime()) continue;

      if (state.latest?.status === 'ready') {
        const ageMs = now.getTime() - new Date(state.latest.takenAt).getTime();
        if (ageMs < config.intervalMinutes * 60 * 1000) continue;
      }

      try {
        await this.service.createSnapshot(database.id, {
          reason: 'scheduled',
          pinned: false,
        });
        this.failures.delete(database.id);
        created += 1;
      } catch (error: any) {
        const attempts = (failure?.attempts || 0) + 1;
        const backoffMinutes = Math.min(30, 5 * 2 ** (attempts - 1));
        this.failures.set(database.id, {
          attempts,
          retryAt: now.getTime() + backoffMinutes * 60 * 1000,
        });
        console.warn(
          `[snapshots] failed for ${database.name} (${database.id}); retrying in ${backoffMinutes} min:`,
          error?.message || error,
        );
      }
    }

    return { scanned, created };
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, Math.max(1000, delayMs));
    this.timer.unref?.();
  }

  private async tick() {
    if (this.stopped) return;
    if (this.running) return;

    this.running = this.runOnce();
    try {
      await this.running;
    } catch (error: any) {
      console.warn('[snapshots] scheduler run failed:', error?.message || error);
    } finally {
      this.running = null;
      if (!this.stopped) {
        this.schedule(getSnapshotConfig().intervalMinutes * 60 * 1000);
      }
    }
  }
}

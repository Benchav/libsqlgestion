import { In } from 'typeorm';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { DatabaseService } from './DatabaseService';

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

type RuntimeHealthMonitorOptions = {
  force?: boolean;
};

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

/**
 * Periodically refreshes persisted runtime health outside request handlers.
 *
 * Background timers created during provisioning are intentionally short-lived;
 * this monitor makes health survive backend restarts and catches routes that
 * degrade hours later (DNS, certificates, proxy changes).
 */
export class RuntimeHealthMonitor {
  private databaseRepo = AppDataSource.getRepository(Database);
  private databaseService = new DatabaseService();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;
  private forceNext = false;

  async start() {
    if (this.timer) return;
    this.stopped = false;
    this.forceNext = true;
    const initialDelayMs = positiveInt(process.env.RUNTIME_HEALTH_STARTUP_DELAY_SECONDS, 20) * 1000;
    this.schedule(initialDelayMs);
    console.log(
      `[runtime-health] monitor enabled (every ${positiveInt(process.env.RUNTIME_HEALTH_INTERVAL_MINUTES, 10)} min)`,
    );
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
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);
    }
  }

  async runOnce(options: RuntimeHealthMonitorOptions = {}) {
    const intervalMs = positiveInt(process.env.RUNTIME_HEALTH_INTERVAL_MINUTES, 10) * 60 * 1000;
    const publicTimeoutMs = positiveInt(process.env.RUNTIME_HEALTH_PUBLIC_TIMEOUT_MS, 5000);
    const now = Date.now();
    const databases = await this.databaseRepo.find({
      where: { status: In(['active', 'inactive']) },
    });

    let checked = 0;
    let skipped = 0;
    let failed = 0;

    const candidates = databases.filter((database) => {
      const runtime = database.metadata?.runtime as Record<string, any> | undefined;
      if (runtime?.provider !== 'docker-libsql') {
        skipped += 1;
        return false;
      }

      const checkedAt = Date.parse(String(runtime?.routeHealth?.checkedAt || ''));
      if (!options.force && Number.isFinite(checkedAt) && now - checkedAt < intervalMs) {
        skipped += 1;
        return false;
      }

      return true;
    });

    // Public checks include DNS and TLS and can take seconds. A sequential
    // loop made a large fleet miss its own interval, so checks run with a
    // bounded concurrency instead of serializing every database.
    const concurrency = positiveInt(process.env.RUNTIME_HEALTH_CONCURRENCY, 4);
    await mapWithConcurrency(candidates, concurrency, async (database) => {
      try {
        await this.databaseService.refreshRuntimeHealth(database.id, {
          publicTimeoutMs,
          recordAudit: false,
        });
        checked += 1;
      } catch (error: any) {
        failed += 1;
        console.warn(
          `[runtime-health] check failed for ${database.name} (${database.id}): ` +
          `${error?.message || error}`,
        );
      }
    });

    return { checked, skipped, failed };
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

    const force = this.forceNext;
    this.forceNext = false;
    this.running = this.runOnce({ force })
      .catch((error: any) => {
        console.warn('[runtime-health] monitor run failed:', error?.message || error);
      })
      .finally(() => {
        this.running = null;
        if (!this.stopped) {
          this.schedule(positiveInt(process.env.RUNTIME_HEALTH_INTERVAL_MINUTES, 10) * 60 * 1000);
        }
      });

    await this.running;
  }
}

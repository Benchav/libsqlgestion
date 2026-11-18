'use client';

import { useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Clock,
  Download,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import {
  DatabaseSnapshot,
  useCreateSnapshot,
  useDeleteSnapshot,
  useRestoreSnapshot,
  useSnapshots,
} from '../lib/hooks';

type SnapshotsCardProps = {
  database: {
    id: string;
    name: string;
    effectiveType?: string;
    runtimeProvider?: string;
  };
  onRestored: (databaseId: string, token: string, databaseName?: string) => void;
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatAge(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';

  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'less than 1 min ago';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString();
}

function reasonLabel(reason: DatabaseSnapshot['reason']) {
  if (reason === 'manual') return 'Manual';
  if (reason === 'pre_restore') return 'Pre-restore';
  return 'Automatic';
}

function statusBadge(snapshot: DatabaseSnapshot) {
  if (snapshot.status === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
        <CheckCircle2 size={10} /> Ready
      </span>
    );
  }

  if (snapshot.status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
        <RefreshCw size={10} className="animate-spin" /> Creating
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
      <XCircle size={10} /> Failed
    </span>
  );
}

export function SnapshotsCard({ database, onRestored }: SnapshotsCardProps) {
  const supported = (database.effectiveType || database.runtimeProvider) === 'sqlite'
    || database.runtimeProvider === 'local-file';

  const snapshotsQuery = useSnapshots(database.id, supported);
  const createSnapshot = useCreateSnapshot(database.id);
  const deleteSnapshot = useDeleteSnapshot(database.id);
  const restoreSnapshot = useRestoreSnapshot(database.id);

  const [actionError, setActionError] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<DatabaseSnapshot | null>(null);
  const [restoreName, setRestoreName] = useState('');
  const [restoreError, setRestoreError] = useState('');

  const snapshots = snapshotsQuery.data?.snapshots || [];
  const totalSizeBytes = snapshotsQuery.data?.totalSizeBytes || 0;
  const policy = snapshotsQuery.data?.policy;
  const snapshotInProgress = createSnapshot.isPending
    || snapshots.some((snapshot) => snapshot.status === 'pending');

  async function handleCreateSnapshot() {
    setActionError('');
    try {
      await createSnapshot.mutateAsync();
    } catch (error: any) {
      setActionError(error?.message || 'Failed to create snapshot');
    }
  }

  async function handleDeleteSnapshot(snapshot: DatabaseSnapshot) {
    if (!window.confirm(`Delete the restore point from ${formatTimestamp(snapshot.takenAt)}?`)) {
      return;
    }

    setActionError('');
    try {
      await deleteSnapshot.mutateAsync(snapshot.id);
    } catch (error: any) {
      setActionError(error?.message || 'Failed to delete snapshot');
    }
  }

  function openRestoreModal(snapshot: DatabaseSnapshot) {
    const stamp = new Date(snapshot.takenAt)
      .toISOString()
      .slice(0, 16)
      .replace(/[-:T]/g, '');
    setRestoreTarget(snapshot);
    setRestoreName(`${database.name}-restore-${stamp}`);
    setRestoreError('');
  }

  async function handleRestore(event: React.FormEvent) {
    event.preventDefault();
    if (!restoreTarget) return;

    setRestoreError('');
    try {
      const result = await restoreSnapshot.mutateAsync({
        snapshotId: restoreTarget.id,
        name: restoreName.trim() || undefined,
      });
      setRestoreTarget(null);
      onRestored(result.database.id, result.token, result.database.name);
    } catch (error: any) {
      setRestoreError(error?.message || 'Failed to restore snapshot');
    }
  }

  return (
    <>
      <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Archive size={16} className="text-zinc-400" />
            <h2 className="font-medium text-zinc-200">Backups & Restore Points</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => snapshotsQuery.refetch()}
              disabled={snapshotsQuery.isFetching}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 rounded-md transition-colors disabled:opacity-40"
              title="Refresh restore points"
            >
              <RefreshCw size={14} className={snapshotsQuery.isFetching ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={handleCreateSnapshot}
              disabled={!supported || snapshotInProgress}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition-colors disabled:cursor-wait disabled:opacity-50"
            >
              <RefreshCw size={14} className={snapshotInProgress ? 'animate-spin' : ''} />
              {snapshotInProgress ? 'Creating...' : 'Create snapshot'}
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {!supported && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
              Snapshots are available for LOCAL-FILE databases in this version.
            </div>
          )}

          {supported && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
              <span className="inline-flex items-center gap-1">
                <Clock size={12} /> Every {policy?.intervalMinutes || 60} min
              </span>
              <span>·</span>
              <span>Retention {policy?.retentionDays || 14} days</span>
              <span>·</span>
              <span>{formatBytes(totalSizeBytes)} in snapshots</span>
            </div>
          )}

          {(actionError || snapshotsQuery.error) && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {actionError || (snapshotsQuery.error as Error)?.message || 'Failed to load restore points'}
            </div>
          )}

          {supported && snapshotsQuery.isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-zinc-500">
              <RefreshCw size={16} className="animate-spin" /> Loading restore points...
            </div>
          ) : supported && snapshots.length === 0 ? (
            <div className="rounded-lg border border-zinc-800/80 bg-[#050505] px-4 py-6 text-center">
              <Archive size={24} className="mx-auto text-zinc-700" />
              <p className="mt-2 text-sm text-zinc-400">No restore points yet.</p>
              <p className="mt-1 text-xs text-zinc-500">
                The scheduler will create the first one automatically. You can also create one manually.
              </p>
            </div>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto custom-scrollbar pr-1">
              {snapshots.map((snapshot) => (
                <div
                  key={snapshot.id}
                  className="rounded-lg border border-zinc-800/80 bg-[#050505] px-3 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {statusBadge(snapshot)}
                        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                          {reasonLabel(snapshot.reason)}
                        </span>
                        {snapshot.pinned && (
                          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Pinned</span>
                        )}
                      </div>
                      <p className="mt-1.5 truncate text-sm text-zinc-300" title={formatTimestamp(snapshot.takenAt)}>
                        {formatTimestamp(snapshot.takenAt)}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {formatAge(snapshot.takenAt)} · {formatBytes(snapshot.sizeBytes)}
                      </p>
                      {snapshot.status === 'failed' && snapshot.errorMessage && (
                        <p className="mt-1 text-xs text-red-400 break-words">{snapshot.errorMessage}</p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openRestoreModal(snapshot)}
                        disabled={snapshot.status !== 'ready' || restoreSnapshot.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <RotateCcw size={12} /> Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          window.location.href = `/api/v1/databases/${database.id}/snapshots/${snapshot.id}/download`;
                        }}
                        disabled={snapshot.status !== 'ready'}
                        className="p-1.5 text-zinc-500 hover:text-zinc-300 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                        title="Download snapshot"
                      >
                        <Download size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSnapshot(snapshot)}
                        disabled={deleteSnapshot.isPending}
                        className="p-1.5 text-zinc-500 hover:text-red-400 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                        title="Delete snapshot"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-zinc-500">
            Snapshots are local point-in-time copies. They do not protect against disk or server loss; keep an
            offsite backup for disaster recovery.
          </p>
        </div>
      </div>

      {restoreTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-[520px] rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-6 shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-zinc-100">Restore snapshot</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  A new database will be created with the data from that moment. The current database is not modified.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRestoreTarget(null)}
                disabled={restoreSnapshot.isPending}
                className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X size={20} />
              </button>
            </div>

            <div className="mb-4 rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-xs text-zinc-400">
              <p><span className="text-zinc-500">Snapshot:</span> {formatTimestamp(restoreTarget.takenAt)}</p>
              <p><span className="text-zinc-500">Size:</span> {formatBytes(restoreTarget.sizeBytes)}</p>
              <p><span className="text-zinc-500">Source:</span> {reasonLabel(restoreTarget.reason)}</p>
            </div>

            {restoreError && (
              <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {restoreError}
              </div>
            )}

            <form onSubmit={handleRestore} className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-300">New database name</label>
                <input
                  type="text"
                  value={restoreName}
                  onChange={(event) => setRestoreName(event.target.value)}
                  disabled={restoreSnapshot.isPending}
                  className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>

              <div className="flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
                <button
                  type="button"
                  onClick={() => setRestoreTarget(null)}
                  disabled={restoreSnapshot.isPending}
                  className="px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={restoreSnapshot.isPending || !restoreName.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw size={14} className={restoreSnapshot.isPending ? 'animate-spin' : ''} />
                  {restoreSnapshot.isPending ? 'Restoring...' : 'Restore database'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

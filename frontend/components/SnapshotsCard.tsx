'use client';

import { useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Clock,
  Download,
  History,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import {
  DatabaseSnapshot,
  DatabaseSnapshotPolicy,
  useCreateSnapshot,
  useDeleteSnapshot,
  useRestoreSnapshot,
  useSnapshotPolicy,
  useSnapshots,
  useUpdateSnapshotPolicy,
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

type PointInTimePreset = '1h' | '6h' | '12h' | '24h' | '48h' | '72h' | '1w' | '2w' | 'custom';

type PolicyForm = Omit<DatabaseSnapshotPolicy, 'databaseId' | 'isDefault'>;

const POINT_IN_TIME_PRESETS: Array<{ value: PointInTimePreset; label: string; ms?: number }> = [
  { value: '1h', label: '1 Hour Ago', ms: 60 * 60 * 1000 },
  { value: '6h', label: '6 Hours Ago', ms: 6 * 60 * 60 * 1000 },
  { value: '12h', label: '12 Hours Ago', ms: 12 * 60 * 60 * 1000 },
  { value: '24h', label: '24 Hours Ago', ms: 24 * 60 * 60 * 1000 },
  { value: '48h', label: '48 Hours Ago', ms: 48 * 60 * 60 * 1000 },
  { value: '72h', label: '72 Hours Ago', ms: 72 * 60 * 60 * 1000 },
  { value: '1w', label: '1 Week Ago', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '2w', label: '2 Weeks Ago', ms: 14 * 24 * 60 * 60 * 1000 },
  { value: 'custom', label: 'Custom' },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(value: number) {
  return String(value).padStart(2, '0');
}

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

function toDateTimeLocal(date: Date) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
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

function milestoneBadges(snapshot: DatabaseSnapshot) {
  const milestones = snapshot.milestones || {};
  const labels: Array<[string, string]> = [];
  if (milestones.daily) labels.push(['D', 'Daily']);
  if (milestones.weekly) labels.push(['W', 'Weekly']);
  if (milestones.monthly) labels.push(['M', 'Monthly']);

  return labels.map(([short, label]) => (
    <span
      key={label}
      title={label}
      className="rounded border border-zinc-700 bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400"
    >
      {short}
    </span>
  ));
}

function defaultPolicyForm(policy?: DatabaseSnapshotPolicy | null): PolicyForm {
  if (policy) {
    return {
      restorePointIntervalMinutes: policy.restorePointIntervalMinutes,
      dailyEnabled: policy.dailyEnabled,
      dailyAtHour: policy.dailyAtHour,
      dailyRetention: policy.dailyRetention,
      weeklyEnabled: policy.weeklyEnabled,
      weeklyDayOfWeek: policy.weeklyDayOfWeek,
      weeklyAtHour: policy.weeklyAtHour,
      weeklyRetention: policy.weeklyRetention,
      monthlyEnabled: policy.monthlyEnabled,
      monthlyDayOfMonth: policy.monthlyDayOfMonth,
      monthlyAtHour: policy.monthlyAtHour,
      monthlyRetention: policy.monthlyRetention,
      timezone: policy.timezone,
    };
  }

  return {
    restorePointIntervalMinutes: 60,
    dailyEnabled: true,
    dailyAtHour: 2,
    dailyRetention: 14,
    weeklyEnabled: false,
    weeklyDayOfWeek: 0,
    weeklyAtHour: 2,
    weeklyRetention: 8,
    monthlyEnabled: false,
    monthlyDayOfMonth: 1,
    monthlyAtHour: 2,
    monthlyRetention: 12,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

function policySummary(policy?: DatabaseSnapshotPolicy) {
  if (!policy) return '';
  const parts = [`Every ${policy.restorePointIntervalMinutes} min`];
  if (policy.dailyEnabled) {
    parts.push(`Daily ${pad(policy.dailyAtHour)}:00 ${policy.timezone} (${policy.dailyRetention})`);
  }
  if (policy.weeklyEnabled) {
    parts.push(`Weekly ${WEEKDAYS[policy.weeklyDayOfWeek]} ${pad(policy.weeklyAtHour)}:00 ${policy.timezone} (${policy.weeklyRetention})`);
  }
  if (policy.monthlyEnabled) {
    parts.push(`Monthly day ${policy.monthlyDayOfMonth} ${pad(policy.monthlyAtHour)}:00 ${policy.timezone} (${policy.monthlyRetention})`);
  }
  return parts.join(' · ');
}

export function SnapshotsCard({ database, onRestored }: SnapshotsCardProps) {
  const supported = (database.effectiveType || database.runtimeProvider) === 'sqlite'
    || database.runtimeProvider === 'local-file';

  const snapshotsQuery = useSnapshots(database.id, supported);
  const policyQuery = useSnapshotPolicy(database.id, supported);
  const createSnapshot = useCreateSnapshot(database.id);
  const deleteSnapshot = useDeleteSnapshot(database.id);
  const restoreSnapshot = useRestoreSnapshot(database.id);
  const updatePolicy = useUpdateSnapshotPolicy(database.id);

  const [actionError, setActionError] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<DatabaseSnapshot | null>(null);
  const [restoreName, setRestoreName] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyForm, setPolicyForm] = useState<PolicyForm>(defaultPolicyForm());
  const [policyError, setPolicyError] = useState('');
  const [pointInTimeOpen, setPointInTimeOpen] = useState(false);
  const [pointInTimePreset, setPointInTimePreset] = useState<PointInTimePreset>('1h');
  const [pointInTimeCustom, setPointInTimeCustom] = useState('');
  const [pointInTimeName, setPointInTimeName] = useState('');
  const [pointInTimeError, setPointInTimeError] = useState('');

  const snapshots = snapshotsQuery.data?.snapshots || [];
  const readySnapshots = snapshots.filter((snapshot) => snapshot.status === 'ready');
  const totalSizeBytes = snapshotsQuery.data?.totalSizeBytes || 0;
  const policy = policyQuery.data?.policy;
  const snapshotInProgress = createSnapshot.isPending
    || snapshots.some((snapshot) => snapshot.status === 'pending');

  const pointInTimeTargetMs = (() => {
    if (pointInTimePreset === 'custom') {
      const parsed = pointInTimeCustom ? new Date(pointInTimeCustom).getTime() : NaN;
      return Number.isFinite(parsed) ? parsed : null;
    }
    const preset = POINT_IN_TIME_PRESETS.find((item) => item.value === pointInTimePreset);
    return preset?.ms ? Date.now() - preset.ms : null;
  })();

  const pointInTimeSnapshot = pointInTimeTargetMs == null
    ? null
    : readySnapshots.find((snapshot) => new Date(snapshot.takenAt).getTime() <= pointInTimeTargetMs) || null;

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

  function openPointInTimeModal() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const firstAvailable = POINT_IN_TIME_PRESETS.find((preset) => {
      if (preset.value === 'custom' || !preset.ms) return false;
      const target = Date.now() - preset.ms;
      return readySnapshots.some((snapshot) => new Date(snapshot.takenAt).getTime() <= target);
    });
    setPointInTimePreset(firstAvailable?.value || 'custom');
    setPointInTimeCustom(toDateTimeLocal(
      firstAvailable ? new Date(Date.now() - 60 * 60 * 1000) : new Date(),
    ));
    setPointInTimeName(`${database.name}-restore-${stamp}`);
    setPointInTimeError('');
    setPointInTimeOpen(true);
  }

  async function handlePointInTimeRestore(event: React.FormEvent) {
    event.preventDefault();
    if (!pointInTimeSnapshot) return;

    setPointInTimeError('');
    try {
      const result = await restoreSnapshot.mutateAsync({
        snapshotId: pointInTimeSnapshot.id,
        name: pointInTimeName.trim() || undefined,
      });
      setPointInTimeOpen(false);
      onRestored(result.database.id, result.token, result.database.name);
    } catch (error: any) {
      setPointInTimeError(error?.message || 'Failed to restore snapshot');
    }
  }

  function openPolicyModal() {
    setPolicyForm(defaultPolicyForm(policy));
    setPolicyError('');
    setPolicyOpen(true);
  }

  async function handleSavePolicy(event: React.FormEvent) {
    event.preventDefault();
    setPolicyError('');
    try {
      await updatePolicy.mutateAsync(policyForm);
      setPolicyOpen(false);
    } catch (error: any) {
      setPolicyError(error?.message || 'Failed to save backup policy');
    }
  }

  function updatePolicyNumber(field: keyof PolicyForm, value: string) {
    setPolicyForm((current) => ({ ...current, [field]: Number(value) }));
  }

  return (
    <>
      <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Archive size={16} className="text-zinc-400" />
            <h2 className="font-medium text-zinc-200">Backups & Restore Points</h2>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
              onClick={openPolicyModal}
              disabled={!supported}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              <Settings2 size={14} /> Backup policy
            </button>
            <button
              type="button"
              onClick={openPointInTimeModal}
              disabled={!supported || readySnapshots.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              <History size={14} /> Point-in-time
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
                <Clock size={12} /> {policySummary(policy) || 'Loading backup policy...'}
              </span>
              <span>·</span>
              <span>{formatBytes(totalSizeBytes)} in snapshots</span>
            </div>
          )}

          {(actionError || snapshotsQuery.error || policyQuery.error) && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {actionError
                || (snapshotsQuery.error as Error)?.message
                || (policyQuery.error as Error)?.message
                || 'Failed to load restore points'}
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
                        {milestoneBadges(snapshot)}
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

      {pointInTimeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-[560px] rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-6 shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-zinc-100">Create Database from Point-in-Time</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  The nearest available snapshot at or before the selected time will be used.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPointInTimeOpen(false)}
                disabled={restoreSnapshot.isPending}
                className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-300">Database name</label>
                <input
                  type="text"
                  value={pointInTimeName}
                  onChange={(event) => setPointInTimeName(event.target.value)}
                  disabled={restoreSnapshot.isPending}
                  className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-300">Restore from</label>
                <select
                  value={pointInTimePreset}
                  onChange={(event) => setPointInTimePreset(event.target.value as PointInTimePreset)}
                  disabled={restoreSnapshot.isPending}
                  className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {POINT_IN_TIME_PRESETS.map((preset) => {
                    if (preset.value === 'custom') {
                      return <option key={preset.value} value={preset.value}>{preset.label}</option>;
                    }
                    const target = Date.now() - (preset.ms || 0);
                    const available = readySnapshots.some(
                      (snapshot) => new Date(snapshot.takenAt).getTime() <= target,
                    );
                    return (
                      <option key={preset.value} value={preset.value} disabled={!available}>
                        {preset.label}{available ? '' : ' (no snapshot)'}
                      </option>
                    );
                  })}
                </select>
              </div>

              {pointInTimePreset === 'custom' && (
                <div>
                  <label className="mb-2 block text-sm font-medium text-zinc-300">Custom date and time</label>
                  <input
                    type="datetime-local"
                    value={pointInTimeCustom}
                    onChange={(event) => setPointInTimeCustom(event.target.value)}
                    disabled={restoreSnapshot.isPending}
                    className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>
              )}

              <div className="rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-xs text-zinc-400">
                {pointInTimeSnapshot ? (
                  <>
                    <p><span className="text-zinc-500">Nearest snapshot:</span> {formatTimestamp(pointInTimeSnapshot.takenAt)}</p>
                    <p><span className="text-zinc-500">Age:</span> {formatAge(pointInTimeSnapshot.takenAt)}</p>
                    <p><span className="text-zinc-500">Size:</span> {formatBytes(pointInTimeSnapshot.sizeBytes)}</p>
                  </>
                ) : (
                  <p className="text-amber-300">No snapshot is available at or before this point in time.</p>
                )}
              </div>

              {pointInTimeError && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                  {pointInTimeError}
                </div>
              )}

              <div className="flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
                <button
                  type="button"
                  onClick={() => setPointInTimeOpen(false)}
                  disabled={restoreSnapshot.isPending}
                  className="px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePointInTimeRestore}
                  disabled={restoreSnapshot.isPending || !pointInTimeSnapshot || !pointInTimeName.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw size={14} className={restoreSnapshot.isPending ? 'animate-spin' : ''} />
                  {restoreSnapshot.isPending ? 'Restoring...' : 'Create Database'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {policyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-[640px] rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-6 shadow-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-zinc-100">Backup policy</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Configure restore points and long-term daily, weekly and monthly backups.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPolicyOpen(false)}
                disabled={updatePolicy.isPending}
                className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X size={20} />
              </button>
            </div>

            {policyError && (
              <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {policyError}
              </div>
            )}

            <form onSubmit={handleSavePolicy} className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-300">Restore points</label>
                <select
                  value={policyForm.restorePointIntervalMinutes}
                  onChange={(event) => updatePolicyNumber('restorePointIntervalMinutes', event.target.value)}
                  disabled={updatePolicy.isPending}
                  className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
                >
                  <option value={15}>Every 15 minutes</option>
                  <option value={30}>Every 30 minutes</option>
                  <option value={60}>Every 60 minutes</option>
                  <option value={120}>Every 2 hours</option>
                </select>
              </div>

              <div className="space-y-3 rounded-lg border border-zinc-800 bg-[#050505] p-4">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-zinc-300">Daily backups</span>
                  <input
                    type="checkbox"
                    checked={policyForm.dailyEnabled}
                    onChange={(event) => setPolicyForm((current) => ({ ...current, dailyEnabled: event.target.checked }))}
                    disabled={updatePolicy.isPending}
                    className="h-4 w-4 accent-zinc-100"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-zinc-500">
                    At hour
                    <select
                      value={policyForm.dailyAtHour}
                      onChange={(event) => updatePolicyNumber('dailyAtHour', event.target.value)}
                      disabled={updatePolicy.isPending || !policyForm.dailyEnabled}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-[#0f0f0f] px-2 py-1.5 text-sm text-zinc-200 disabled:opacity-50"
                    >
                      {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{pad(hour)}:00</option>)}
                    </select>
                  </label>
                  <label className="text-xs text-zinc-500">
                    Keep last
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={policyForm.dailyRetention}
                      onChange={(event) => updatePolicyNumber('dailyRetention', event.target.value)}
                      disabled={updatePolicy.isPending || !policyForm.dailyEnabled}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-[#0f0f0f] px-2 py-1.5 text-sm text-zinc-200 disabled:opacity-50"
                    />
                  </label>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-zinc-800 bg-[#050505] p-4">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-zinc-300">Weekly backups</span>
                  <input
                    type="checkbox"
                    checked={policyForm.weeklyEnabled}
                    onChange={(event) => setPolicyForm((current) => ({ ...current, weeklyEnabled: event.target.checked }))}
                    disabled={updatePolicy.isPending}
                    className="h-4 w-4 accent-zinc-100"
                  />
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <label className="text-xs text-zinc-500">
                    Day
                    <select
                      value={policyForm.weeklyDayOfWeek}
                      onChange={(event) => updatePolicyNumber('weeklyDayOfWeek', event.target.value)}
                      disabled={updatePolicy.isPending || !policyForm.weeklyEnabled}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-[#0f0f0f] px-2 py-1.5 text-sm text-zinc-200 disabled:opacity-50"
                    >
                      {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
                    </select>
                  </label>
                  <label className="text-xs text-zinc-500">
                    At hour
                    <select
                      value={policyForm.weeklyAtHour}
                      onChange={(event) => updatePolicyNumber('weeklyAtHour', event.target.value)}
                      disabled={updatePolicy.isPending || !policyForm.weeklyEnabled}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-[#0f0f0f] px-2 py-1.5 text-sm text-zinc-200 disabled:opacity-50"
                    >
                      {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{pad(hour)}:00</option>)}
                    </select>
                  </label>
                  <label className="text-xs text-zinc-500">
                    Keep last
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={policyForm.weeklyRetention}
                      onChange={(event) => updatePolicyNumber('weeklyRetention', event.target.value)}
                      disabled={updatePolicy.isPending || !policyForm.weeklyEnabled}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-[#0f0f0f] px-2 py-1.5 text-sm text-zinc-200 disabled:opacity-50"
                    />
                  </label>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-zinc-800 bg-[#050505] p-4">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-zinc-300">Monthly backups</span>
                  <input
                    type="checkbox"
                    checked={policyForm.monthlyEnabled}
                    onChange={(event) => setPolicyForm((current) => ({ ...current, monthlyEnabled: event.target.checked }))}
                    disabled={updatePolicy.isPending}
                    className="h-4 w-4 accent-zinc-100"
                  />
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <label className="text-xs text-zinc-500">
                    Day of month
                    <select
                      value={policyForm.monthlyDayOfMonth}
                      onChange={(event) => updatePolicyNumber('monthlyDayOfMonth', event.target.value)}
                      disabled={updatePolicy.isPending || !policyForm.monthlyEnabled}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-[#0f0f0f] px-2 py-1.5 text-sm text-zinc-200 disabled:opacity-50"
                    >
                      {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                        <option key={day} value={day}>{day}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-zinc-500">
                    At hour
                    <select
                      value={policyForm.monthlyAtHour}
                      onChange={(event) => updatePolicyNumber('monthlyAtHour', event.target.value)}
                      disabled={updatePolicy.isPending || !policyForm.monthlyEnabled}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-[#0f0f0f] px-2 py-1.5 text-sm text-zinc-200 disabled:opacity-50"
                    >
                      {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{pad(hour)}:00</option>)}
                    </select>
                  </label>
                  <label className="text-xs text-zinc-500">
                    Keep last
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={policyForm.monthlyRetention}
                      onChange={(event) => updatePolicyNumber('monthlyRetention', event.target.value)}
                      disabled={updatePolicy.isPending || !policyForm.monthlyEnabled}
                      className="mt-1 w-full rounded-md border border-zinc-800 bg-[#0f0f0f] px-2 py-1.5 text-sm text-zinc-200 disabled:opacity-50"
                    />
                  </label>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-300">Timezone</label>
                <input
                  type="text"
                  value={policyForm.timezone}
                  onChange={(event) => setPolicyForm((current) => ({ ...current, timezone: event.target.value }))}
                  disabled={updatePolicy.isPending}
                  placeholder="UTC"
                  className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  IANA timezone, for example UTC or America/La_Paz.
                </p>
              </div>

              <div className="flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
                <button
                  type="button"
                  onClick={() => setPolicyOpen(false)}
                  disabled={updatePolicy.isPending}
                  className="px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updatePolicy.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw size={14} className={updatePolicy.isPending ? 'animate-spin' : ''} />
                  {updatePolicy.isPending ? 'Saving...' : 'Save policy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

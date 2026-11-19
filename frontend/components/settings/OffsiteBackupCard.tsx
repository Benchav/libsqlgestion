"use client";

import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';

type OffsiteSettings = {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKeyConfigured: boolean;
  secretSource: 'panel' | 'env' | 'none';
  uploadMode: 'all' | 'daily' | 'manual';
  artifacts: 'db' | 'db+sql';
  retentionDays: number;
  required: boolean;
  timeoutMs: number;
  lastTestAt?: string;
  lastTestOk?: boolean;
  lastError?: string;
  lastUploadAt?: string;
};

type OffsiteStatus = {
  configured: boolean;
  pendingUploads: number;
  failedUploads: number;
  uploaded: number;
  queued: number;
  lastTestAt?: string;
  lastTestOk?: boolean;
  lastError?: string;
  lastUploadAt?: string;
};

const DEFAULT_SETTINGS: OffsiteSettings = {
  enabled: false,
  endpoint: '',
  bucket: '',
  region: 'auto',
  prefix: 'libsqlite',
  accessKeyId: '',
  secretAccessKeyConfigured: false,
  secretSource: 'none',
  uploadMode: 'daily',
  artifacts: 'db',
  retentionDays: 30,
  required: false,
  timeoutMs: 300000,
};

const DEFAULT_STATUS: OffsiteStatus = {
  configured: false,
  pendingUploads: 0,
  failedUploads: 0,
  uploaded: 0,
  queued: 0,
};

export function OffsiteBackupCard({ canWrite }: { canWrite: boolean }) {
  const [settings, setSettings] = useState<OffsiteSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<OffsiteStatus>(DEFAULT_STATUS);
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const result = await apiRequest<{ settings: OffsiteSettings; status: OffsiteStatus }>(
        '/settings/offsite-backup',
      );
      setSettings({ ...DEFAULT_SETTINGS, ...result.settings });
      setStatus({ ...DEFAULT_STATUS, ...result.status });
    } catch (error: any) {
      setMessage({ kind: 'error', text: error?.message || 'Failed to load offsite settings' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function buildPayload() {
    return {
      enabled: settings.enabled,
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      prefix: settings.prefix,
      accessKeyId: settings.accessKeyId,
      uploadMode: settings.uploadMode,
      artifacts: settings.artifacts,
      retentionDays: settings.retentionDays,
      required: settings.required,
      timeoutMs: settings.timeoutMs,
      ...(secretAccessKey.trim() ? { secretAccessKey: secretAccessKey.trim() } : {}),
      ...(clearSecret ? { clearSecret: true } : {}),
    };
  }

  async function saveSettings() {
    const result = await apiRequest<{ settings: OffsiteSettings; status: OffsiteStatus }>(
      '/settings/offsite-backup',
      {
        method: 'PUT',
        body: JSON.stringify(buildPayload()),
      },
    );
    setSettings({ ...DEFAULT_SETTINGS, ...result.settings });
    setStatus({ ...DEFAULT_STATUS, ...result.status });
    setSecretAccessKey('');
    setClearSecret(false);
    return result;
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      await saveSettings();
      setMessage({ kind: 'ok', text: 'Offsite settings saved.' });
      await load();
    } catch (error: any) {
      setMessage({ kind: 'error', text: error?.message || 'Failed to save offsite settings' });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setMessage({ kind: 'info', text: 'Saving and testing the bucket connection...' });
    try {
      await saveSettings();
      const result = await apiRequest<{
        ok: boolean;
        latencyMs: number;
        message: string;
      }>('/settings/offsite-backup/test', { method: 'POST', body: JSON.stringify({}) });
      setMessage({
        kind: 'ok',
        text: `${result.message || 'Connection OK.'} (${result.latencyMs}ms)`,
      });
      await load();
    } catch (error: any) {
      setMessage({ kind: 'error', text: error?.message || 'Offsite connection failed' });
      await load().catch(() => undefined);
    } finally {
      setTesting(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMessage(null);
    try {
      const result = await apiRequest<{ queued: number }>('/settings/offsite-backup/sync', {
        method: 'POST',
        body: JSON.stringify({ includeExisting, limit: 25 }),
      });
      setMessage({
        kind: result.queued > 0 ? 'ok' : 'info',
        text: result.queued > 0
          ? `${result.queued} snapshot(s) queued for offsite upload.`
          : 'No snapshots needed to be queued.',
      });
      await load();
    } catch (error: any) {
      setMessage({ kind: 'error', text: error?.message || 'Failed to queue offsite uploads' });
    } finally {
      setSyncing(false);
    }
  }

  const inputClass = 'flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:opacity-50';
  const labelClass = 'w-44 text-sm font-medium text-zinc-300';

  return (
    <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
      <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cloud size={16} className="text-zinc-400" />
          <h2 className="font-medium text-zinc-200">Offsite Backups (S3 / Cloudflare R2)</h2>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
          status.configured && settings.enabled
            ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
            : 'border-zinc-700 bg-zinc-900 text-zinc-400'
        }`}>
          {status.configured && settings.enabled
            ? <CheckCircle2 size={12} />
            : <XCircle size={12} />}
          {status.configured && settings.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      <div className="p-6 space-y-5">
        <p className="text-sm text-zinc-400">
          Keep a second copy of finished snapshots in an S3-compatible bucket. Local
          snapshots remain the primary restore path; a bucket outage never blocks a
          local backup.
        </p>

        <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2">
          <span className="text-sm text-zinc-300">Enable offsite uploads</span>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={!canWrite || loading || saving}
            onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))}
            className="h-4 w-4 accent-zinc-100 disabled:opacity-40"
          />
        </label>

        {loading ? (
          <div className="text-sm text-zinc-500">Loading offsite settings...</div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            <div className="flex items-center gap-4">
              <label className={labelClass}>Endpoint</label>
              <input
                type="url"
                value={settings.endpoint}
                placeholder="https://<account-id>.r2.cloudflarestorage.com"
                disabled={!canWrite || saving}
                onChange={(event) => setSettings((current) => ({ ...current, endpoint: event.target.value }))}
                className={inputClass}
              />
            </div>

            <div className="flex items-center gap-4">
              <label className={labelClass}>Bucket</label>
              <input
                type="text"
                value={settings.bucket}
                placeholder="libsqlite-backups"
                disabled={!canWrite || saving}
                onChange={(event) => setSettings((current) => ({ ...current, bucket: event.target.value }))}
                className={inputClass}
              />
            </div>

            <div className="flex items-center gap-4">
              <label className={labelClass}>Region</label>
              <input
                type="text"
                value={settings.region}
                placeholder="auto"
                disabled={!canWrite || saving}
                onChange={(event) => setSettings((current) => ({ ...current, region: event.target.value }))}
                className={inputClass}
              />
            </div>

            <div className="flex items-center gap-4">
              <label className={labelClass}>Access key ID</label>
              <input
                type="text"
                value={settings.accessKeyId}
                disabled={!canWrite || saving}
                onChange={(event) => setSettings((current) => ({ ...current, accessKeyId: event.target.value }))}
                className={inputClass}
              />
            </div>

            <div className="flex items-center gap-4">
              <label className={labelClass}>Secret access key</label>
              <div className="flex-1">
                <div className="relative">
                  <KeyRound size={14} className="pointer-events-none absolute left-3 top-2.5 text-zinc-600" />
                  <input
                    type="password"
                    value={secretAccessKey}
                    placeholder={settings.secretAccessKeyConfigured
                      ? 'Stored secret — leave blank to keep it'
                      : 'Enter the R2 secret access key'}
                    disabled={!canWrite || saving || clearSecret}
                    onChange={(event) => setSecretAccessKey(event.target.value)}
                    className={`${inputClass} w-full pl-9`}
                  />
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  Source: {settings.secretSource === 'panel'
                    ? 'saved encrypted in the panel'
                    : settings.secretSource === 'env'
                      ? 'SNAPSHOT_OFFSITE_SECRET_ACCESS_KEY'
                      : 'not configured'}.
                  {settings.secretAccessKeyConfigured && settings.secretSource === 'panel' && (
                    <label className="ml-2 inline-flex items-center gap-1 text-zinc-400">
                      <input
                        type="checkbox"
                        checked={clearSecret}
                        disabled={!canWrite || saving}
                        onChange={(event) => setClearSecret(event.target.checked)}
                        className="h-3 w-3 accent-zinc-100"
                      />
                      clear stored secret
                    </label>
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <label className={labelClass}>Object prefix</label>
              <input
                type="text"
                value={settings.prefix}
                placeholder="libsqlite"
                disabled={!canWrite || saving}
                onChange={(event) => setSettings((current) => ({ ...current, prefix: event.target.value }))}
                className={inputClass}
              />
            </div>

            <div className="flex items-center gap-4">
              <label className={labelClass}>Upload policy</label>
              <select
                value={settings.uploadMode}
                disabled={!canWrite || saving}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  uploadMode: event.target.value as OffsiteSettings['uploadMode'],
                }))}
                className={inputClass}
              >
                <option value="daily">Daily + manual snapshots (recommended for R2 free)</option>
                <option value="all">All ready snapshots</option>
                <option value="manual">Manual only</option>
              </select>
            </div>

            <div className="flex items-center gap-4">
              <label className={labelClass}>Artifacts</label>
              <select
                value={settings.artifacts}
                disabled={!canWrite || saving}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  artifacts: event.target.value as OffsiteSettings['artifacts'],
                }))}
                className={inputClass}
              >
                <option value="db">SQLite .db preferred only</option>
                <option value="db+sql">.db + retained .sql</option>
              </select>
            </div>

            <div className="flex items-center gap-4">
              <label className={labelClass}>Remote retention (days)</label>
              <input
                type="number"
                min={1}
                max={3650}
                value={settings.retentionDays}
                disabled={!canWrite || saving}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  retentionDays: Number(event.target.value) || 30,
                }))}
                className={inputClass}
              />
            </div>

            <label className="ml-48 flex items-start gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={settings.required}
                disabled={!canWrite || saving}
                onChange={(event) => setSettings((current) => ({ ...current, required: event.target.checked }))}
                className="mt-0.5 h-3.5 w-3.5 accent-zinc-100"
              />
              <span>
                Keep local snapshots until the offsite upload succeeds. Failed uploads
                can temporarily exceed the local retention policy; monitor disk.
              </span>
            </label>

            <p className="ml-48 text-xs leading-relaxed text-zinc-500">
              R2 free tier is about 10 GB-month. With ~100 MB snapshots, daily uploads
              and 30-day retention use roughly 3 GB. Remote copies are never deleted
              just because a local snapshot is pruned.
            </p>

            <div className="rounded-lg border border-zinc-800 bg-[#050505] p-3 text-xs text-zinc-400">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <span>Uploaded: <strong className="text-zinc-200">{status.uploaded}</strong></span>
                <span>Queued: <strong className="text-zinc-200">{status.queued}</strong></span>
                <span>Pending: <strong className="text-zinc-200">{status.pendingUploads}</strong></span>
                <span>Failed: <strong className={status.failedUploads ? 'text-red-300' : 'text-zinc-200'}>{status.failedUploads}</strong></span>
              </div>
              <p className="mt-2 text-zinc-500">
                Last upload: {status.lastUploadAt ? new Date(status.lastUploadAt).toLocaleString() : '—'}
                {' · '}
                Last test: {status.lastTestAt
                  ? `${new Date(status.lastTestAt).toLocaleString()} (${status.lastTestOk ? 'OK' : 'failed'})`
                  : '—'}
              </p>
              {(status.lastError || settings.lastError) && (
                <p className="mt-1 break-words text-red-300">{status.lastError || settings.lastError}</p>
              )}
            </div>

            {message && (
              <div className={`rounded-lg border px-3 py-2 text-xs ${
                message.kind === 'ok'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : message.kind === 'error'
                    ? 'border-red-500/30 bg-red-500/10 text-red-300'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400'
              }`}>
                {message.text}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800/60 pt-4">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={includeExisting}
                  onChange={(event) => setIncludeExisting(event.target.checked)}
                  disabled={!canWrite || syncing}
                  className="h-3.5 w-3.5 accent-zinc-100"
                />
                Include existing snapshots in sync (backfill)
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleSync}
                  disabled={!canWrite || syncing || !settings.enabled}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                >
                  <UploadCloud size={14} className={syncing ? 'animate-pulse' : ''} />
                  {syncing ? 'Queueing...' : 'Sync pending'}
                </button>
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={!canWrite || testing || saving}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                >
                  <ShieldCheck size={14} />
                  {testing ? 'Testing...' : 'Test connection'}
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!canWrite || saving || testing}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
                >
                  {saving && <RefreshCw size={14} className="animate-spin" />}
                  {saving ? 'Saving...' : 'Save offsite settings'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

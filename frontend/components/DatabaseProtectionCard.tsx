"use client";

import React, { useState } from 'react';
import { AlertTriangle, Eye, Pencil, Shield } from 'lucide-react';
import { useUpdateDatabaseProtection } from '../lib/hooks';

type ProtectionDatabase = {
  id: string;
  name: string;
  blockReads?: boolean;
  blockWrites?: boolean;
  deleteProtection?: boolean;
  runtimeProvider?: string;
  effectiveType?: string;
  gatewayEnabled?: boolean;
  gatewayMode?: 'path' | 'root' | 'none';
  gatewayHttpsUrl?: string;
  gatewayLibsqlUrl?: string;
};

type Props = {
  database: ProtectionDatabase;
  onUpdated: (database: any) => void;
};

type ProtectionKey = 'blockReads' | 'blockWrites' | 'deleteProtection';

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
        checked
          ? 'border-zinc-300 bg-zinc-100'
          : 'border-zinc-700 bg-zinc-800'
      } ${disabled ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
          checked ? 'translate-x-6 bg-zinc-900' : 'translate-x-1 bg-zinc-400'
        }`}
      />
    </button>
  );
}

function ToggleRow({
  title,
  description,
  icon,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-zinc-800/70 py-5 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 gap-3">
        <div className="mt-0.5 text-zinc-500">{icon}</div>
        <div>
          <p className="text-sm font-medium text-zinc-200">{title}</p>
          <p className="mt-1 text-sm text-zinc-500">{description}</p>
        </div>
      </div>
      <Switch checked={checked} disabled={disabled} label={title} onChange={onChange} />
    </div>
  );
}

export function DatabaseProtectionCard({ database, onUpdated }: Props) {
  const updateProtection = useUpdateDatabaseProtection(database.id);
  const [pendingKey, setPendingKey] = useState<ProtectionKey | null>(null);
  const [error, setError] = useState('');

  const dataPlaneActive = Boolean(database.blockReads || database.blockWrites);
  const directClientWarning = database.effectiveType === 'remote'
    || database.runtimeProvider === 'sqld-namespace'
    || database.runtimeProvider === 'docker-libsql'
    || (
      database.effectiveType === 'libsql'
      && database.runtimeProvider !== 'sqld-namespace'
      && database.runtimeProvider !== 'docker-libsql'
    );

  async function handleToggle(key: ProtectionKey, nextValue: boolean) {
    if (pendingKey) return;

    if (nextValue && (key === 'blockReads' || key === 'blockWrites')) {
      const label = key === 'blockReads' ? 'read' : 'write';
      const confirmed = window.confirm(
        `Enable Block ${key === 'blockReads' ? 'Reads' : 'Writes'}?\n\n` +
        `The panel will reject ${label} operations immediately. ` +
        'If the ERP or another client is connected through the panel, it will stop working until you disable this switch.',
      );
      if (!confirmed) return;
    }

    setError('');
    setPendingKey(key);
    try {
      const result = await updateProtection.mutateAsync({ [key]: nextValue });
      onUpdated(result.database);
    } catch (err: any) {
      setError(err?.message || 'Failed to update database protection.');
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
      <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-zinc-400" />
          <h2 className="font-medium text-zinc-200">Configuration</h2>
        </div>
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">
          Data-plane protections
        </span>
      </div>

      <div className="px-6 pt-4">
        {dataPlaneActive && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" />
            <span>
              One or more protections are active on this database. Clients may be receiving
              blocked-operation errors until the switches are turned off.
            </span>
          </div>
        )}

        {directClientWarning && (
          <div className={`mb-4 rounded-lg border px-3 py-2.5 text-xs leading-relaxed ${
            database.gatewayEnabled
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
              : 'border-zinc-700/70 bg-zinc-900/40 text-zinc-400'
          }`}>
            {database.gatewayEnabled && database.gatewayMode === 'root' ? (
              <>
                The direct URL is routed through the root gateway. These switches apply to the ERP
                and the panel. Do not use the runtime IP:port or an alternate direct route.
              </>
            ) : database.gatewayEnabled ? (
              <>
                A Gateway URL is configured for this database. Use the Gateway URL in the ERP to
                enforce these switches. The direct public libSQL URL still bypasses them until the
                runtime is internalized.
              </>
            ) : (
              <>
                These switches are enforced by the panel and its HTTP pipeline. If a client connects
                directly to the public libSQL URL, that connection is outside this backend and is not
                covered by these switches.
              </>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>

      <div className="px-6 pb-6">
        <ToggleRow
          title="Block Reads"
          description="Block read operations that return rows to clients, including SELECT and RETURNING."
          icon={<Eye size={16} />}
          checked={Boolean(database.blockReads)}
          disabled={Boolean(pendingKey)}
          onChange={() => void handleToggle('blockReads', !database.blockReads)}
        />
        <ToggleRow
          title="Block Writes"
          description="Block INSERT, UPDATE, DELETE, DDL and mutating PRAGMAs. Reads remain available."
          icon={<Pencil size={16} />}
          checked={Boolean(database.blockWrites)}
          disabled={Boolean(pendingKey)}
          onChange={() => void handleToggle('blockWrites', !database.blockWrites)}
        />
        <ToggleRow
          title="Delete Protection"
          description="Prevent this database and its project from being deleted until this switch is off."
          icon={<Shield size={16} />}
          checked={Boolean(database.deleteProtection)}
          disabled={Boolean(pendingKey)}
          onChange={() => void handleToggle('deleteProtection', !database.deleteProtection)}
        />
      </div>
    </div>
  );
}

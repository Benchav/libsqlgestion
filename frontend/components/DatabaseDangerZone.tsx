"use client";

import React, { useState } from 'react';
import { AlertTriangle, KeyRound, ShieldAlert, Trash2, X } from 'lucide-react';
import { useDeleteDatabase, useInvalidateDatabaseTokens } from '../lib/hooks';

type DangerDatabase = {
  id: string;
  name: string;
  deleteProtection?: boolean;
  runtimeProvider?: string;
  effectiveType?: string;
};

type Props = {
  database: DangerDatabase;
  onTokenInvalidated: (token: string, database: any) => void;
  onDeleted: () => void | Promise<void>;
};

function confirmationMatches(value: string, databaseName: string) {
  return value.trim() === databaseName;
}

export function DatabaseDangerZone({ database, onTokenInvalidated, onDeleted }: Props) {
  const invalidateTokens = useInvalidateDatabaseTokens(database.id);
  const deleteDatabase = useDeleteDatabase();
  const [action, setAction] = useState<'tokens' | 'delete' | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState('');

  const isProtected = Boolean(database.deleteProtection);
  const unsupportedProvider = database.effectiveType === 'remote'
    || (
      database.effectiveType === 'libsql'
      && database.runtimeProvider !== 'sqld-namespace'
      && database.runtimeProvider !== 'docker-libsql'
    );
  const namespaceWarning = database.runtimeProvider === 'sqld-namespace';
  const runtimeWarning = database.runtimeProvider === 'docker-libsql';
  const busy = invalidateTokens.isPending || deleteDatabase.isPending;
  const confirmed = confirmationMatches(confirmName, database.name);

  function openAction(next: 'tokens' | 'delete') {
    setAction(next);
    setConfirmName('');
    setError('');
  }

  async function handleInvalidate() {
    if (!confirmed || busy) return;
    setError('');
    try {
      const result = await invalidateTokens.mutateAsync();
      onTokenInvalidated(result.token, result.database);
      setAction(null);
      setConfirmName('');
    } catch (err: any) {
      setError(err?.message || 'Failed to invalidate database tokens.');
    }
  }

  async function handleDelete() {
    if (!confirmed || busy || isProtected) return;
    setError('');
    try {
      await deleteDatabase.mutateAsync(database.id);
      setAction(null);
      setConfirmName('');
      await onDeleted();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete database.');
    }
  }

  return (
    <>
      <div className="border border-red-500/20 rounded-xl bg-[#0f0f0f] overflow-hidden">
        <div className="px-6 py-4 border-b border-red-500/20 bg-red-500/5 flex items-center gap-2">
          <ShieldAlert size={16} className="text-red-400" />
          <h2 className="font-medium text-red-300">Danger Zone</h2>
        </div>

        <div className="divide-y divide-zinc-800/70">
          <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-2xl">
              <h3 className="text-sm font-medium text-zinc-200">
                {namespaceWarning ? 'Invalidate Panel Token' : 'Invalidate Database Tokens'}
              </h3>
              <p className="mt-1 text-sm text-zinc-500">
                Generates a new credential and invalidates the current one. Every application
                using this database must be updated with the new token.
              </p>
              {namespaceWarning && (
                <p className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-200">
                  For shared sqld namespaces this panel can rotate its own token, but JWTs already
                  issued directly against the sqld URL may remain valid until they expire.
                </p>
              )}
              {runtimeWarning && (
                <p className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-200">
                  This recreates the dedicated libSQL runtime. Expect a brief interruption while
                  the replacement starts.
                </p>
              )}
              {unsupportedProvider && (
                <p className="mt-2 text-xs text-zinc-500">
                  Token invalidation is not available for externally managed databases.
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={unsupportedProvider || busy}
              onClick={() => openAction('tokens')}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <KeyRound size={15} />
              {namespaceWarning ? 'Invalidate Panel Token' : 'Invalidate All Tokens'}
            </button>
          </div>

          <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-2xl">
              <h3 className="text-sm font-medium text-zinc-200">Delete Database</h3>
              <p className="mt-1 text-sm text-zinc-500">
                Permanently delete this database, its runtime and all of its data. This action
                cannot be undone.
              </p>
              {isProtected && (
                <p className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-200">
                  Delete Protection is enabled. Turn it off in Configuration before deleting.
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={isProtected || busy}
              onClick={() => openAction('delete')}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 size={15} />
              Delete Database
            </button>
          </div>
        </div>
      </div>

      {action && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px] modal-backdrop">
          <div className="w-full max-w-[560px] rounded-xl border border-red-500/20 bg-[#0f0f0f] p-6 shadow-2xl modal-content">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-zinc-100">
                  {action === 'tokens'
                    ? (namespaceWarning ? 'Invalidate Panel Token' : 'Invalidate Database Tokens')
                    : 'Delete Database'}
                </h2>
                <p className="mt-1 text-sm text-zinc-400">
                  {action === 'tokens'
                    ? (namespaceWarning
                      ? 'The panel token is replaced. Direct sqld tokens are not affected.'
                      : 'All clients must be updated with the new token immediately.')
                    : 'This permanently removes the database and cannot be undone.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAction(null)}
                disabled={busy}
                className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"
              >
                <X size={20} />
              </button>
            </div>

            <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" />
              <span>
                {action === 'tokens'
                  ? (namespaceWarning
                    ? 'The panel token stops working immediately. JWTs already issued directly against the sqld URL may remain valid until they expire.'
                    : 'The current token stops working immediately. If the token is not copied and delivered to the ERP, the application will be disconnected.')
                  : 'There is no recovery from this action. Take a verified snapshot before continuing.'}
              </span>
            </div>

            {error && (
              <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {error}
              </div>
            )}

            <label className="mb-2 block text-sm font-medium text-zinc-300">
              Type <span className="font-mono text-zinc-100">{database.name}</span> to confirm
            </label>
            <input
              autoFocus
              type="text"
              value={confirmName}
              onChange={(event) => {
                setConfirmName(event.target.value);
                if (error) setError('');
              }}
              disabled={busy}
              className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
              placeholder={database.name}
            />

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setAction(null)}
                disabled={busy}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!confirmed || busy}
                onClick={() => void (action === 'tokens' ? handleInvalidate() : handleDelete())}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy
                  ? 'Working...'
                  : action === 'tokens'
                    ? 'Invalidate Tokens'
                    : 'Delete Database'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

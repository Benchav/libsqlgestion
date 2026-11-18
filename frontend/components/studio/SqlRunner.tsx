"use client";

import { useState, useRef, useEffect } from 'react';
import { Play, CheckCircle2, AlertCircle, Database } from 'lucide-react';

type Props = {
  onExecute: (sql: string) => void;
  onLoadMore?: () => void;
  loading: boolean;
  loadingMore?: boolean;
  result: {
    ok: boolean;
    rows?: unknown[];
    error?: string;
    changes?: number;
    statementsExecuted?: number;
    statementResults?: Array<{ index: number; sql: string; kind: 'read' | 'write'; rows?: unknown[]; rowsAffected?: number; lastInsertRowid?: unknown }>;
    rowsReturned?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
    totalRows?: number;
    truncated?: boolean;
    durationMs?: number;
  } | null;
};

export function SqlRunner({ onExecute, onLoadMore, loading, loadingMore = false, result }: Props) {
  const [sql, setSql] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleRun() {
    if (sql.trim()) onExecute(sql.trim());
  }

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 300) + 'px';
    }
  }, [sql]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0a0a0a] text-[13px] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/80 bg-[#09090b] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Database size={16} className="text-zinc-400" />
          <span className="font-semibold text-zinc-100">SQL console</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 font-mono bg-zinc-800/50 px-2 py-1 rounded">Ctrl+Enter</span>
          <button 
            type="button" 
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition-colors text-xs font-medium disabled:opacity-50" 
            onClick={handleRun} 
            disabled={loading || !sql.trim()}
          >
            <Play size={14} className={loading ? 'animate-pulse' : ''} />
            {loading ? 'Running...' : 'Run query'}
          </button>
        </div>
      </div>

      <div className="p-4 border-b border-zinc-800/80 bg-[#09090b] flex-shrink-0">
        <textarea
          ref={textareaRef}
          className="w-full bg-[#18181b] border border-zinc-800 rounded-lg p-3 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors custom-scrollbar resize-none"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder="SELECT * FROM users LIMIT 50;"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              handleRun();
            }
          }}
          spellCheck={false}
          style={{ minHeight: '120px' }}
        />
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-auto custom-scrollbar p-4 relative bg-[#0a0a0a]">
        {loading ? (
          <div className="animate-fadeIn space-y-3">
            <div className="flex items-center gap-2 mb-3">
              <div className="spinner spinner-sm" style={{ borderTopColor: '#34d399' }}></div>
              <span className="text-xs text-zinc-500 font-medium">Executing query…</span>
            </div>
            <div className="border border-zinc-800/80 rounded-lg overflow-hidden bg-[#09090b]">
              <div className="px-3 py-2 border-b border-zinc-800/80 bg-[#09090b]">
                <div className="skeleton skeleton-text w-32"></div>
              </div>
              <div className="p-0">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex border-b border-zinc-800/40 px-3 py-2.5 gap-6">
                    <div className="skeleton skeleton-text flex-1" style={{ width: `${30 + Math.random() * 40}%` }}></div>
                    <div className="skeleton skeleton-text flex-1" style={{ width: `${20 + Math.random() * 50}%` }}></div>
                    <div className="skeleton skeleton-text flex-1" style={{ width: `${25 + Math.random() * 35}%` }}></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : result ? (
          result.ok ? (
            <>
              {result.rows && result.rows.length > 0 ? (
                <div className="space-y-2">
                  <div className="border border-zinc-800/80 rounded-lg overflow-hidden bg-[#09090b]">
                    <div className="px-3 py-2 border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-2 bg-[#09090b]">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-emerald-500" />
                        <span className="text-xs font-medium text-emerald-400">
                          Showing {result.rows.length}
                          {result.totalRows !== undefined ? ` of ${result.totalRows.toLocaleString()}` : ''} row{result.rows.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-zinc-500">
                        {typeof result.durationMs === 'number' && <span>{result.durationMs} ms</span>}
                        {result.truncated && <span className="text-amber-400">Preview limited</span>}
                      </div>
                    </div>
                    <div className="overflow-x-auto custom-scrollbar">
                      <table className="w-full text-left border-collapse whitespace-nowrap table-fixed">
                        <thead className="bg-[#09090b]">
                          <tr>
                            {Object.keys(result.rows[0] as object).map((key) => (
                              <th key={key} className="border-b border-r border-zinc-800 py-1.5 px-3 text-zinc-200 font-semibold text-xs min-w-[120px] bg-[#09090b]">
                                {key}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="font-mono text-xs">
                          {result.rows.map((row: any, i) => (
                            <tr key={i} className="hover:bg-zinc-800/40 border-b border-zinc-800/40">
                              {Object.keys(result.rows![0] as object).map((key) => {
                                const val = row?.[key];
                                return (
                                  <td key={key} className={`border-r border-zinc-800/40 px-3 py-1.5 ${val === null ? 'bg-zinc-900/20 text-zinc-600' : 'text-zinc-300'} truncate`}>
                                    {val === null ? 'NULL' : String(val)}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {result.hasMore && onLoadMore && (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/80 bg-[#09090b] px-3 py-2">
                      <span className="text-xs text-zinc-500">
                        More rows are available. Showing a safe preview of {result.rows.length} rows.
                      </span>
                      <button
                        type="button"
                        onClick={onLoadMore}
                        disabled={loadingMore}
                        className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-50"
                      >
                        {loadingMore ? 'Loading...' : `Load next ${result.limit || 200}`}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 px-4 py-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-sm">
                    <CheckCircle2 size={16} />
                    <span>
                      {result.statementsExecuted && result.statementsExecuted > 1
                        ? `Script executed successfully (${result.statementsExecuted} statements)`
                        : 'Query executed successfully'}
                      {result.changes !== undefined ? ` (${result.changes} rows affected)` : ''}
                    </span>
                  </div>

                  {result.statementResults && result.statementResults.length > 1 && (
                    <div className="border border-zinc-800/80 rounded-lg overflow-hidden bg-[#09090b]">
                      <div className="px-3 py-2 border-b border-zinc-800/80 bg-[#09090b] text-xs font-medium text-zinc-400">
                        Statement summary
                      </div>
                      <div className="max-h-56 overflow-auto custom-scrollbar divide-y divide-zinc-800/60">
                        {result.statementResults.map((step) => (
                          <div key={step.index} className="px-3 py-2 text-xs text-zinc-300">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-medium text-zinc-100">#{step.index}</span>
                              <span className="text-zinc-500 uppercase tracking-wider">{step.kind}</span>
                            </div>
                            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-400">{step.sql}</pre>
                            <div className="mt-1 text-zinc-500">
                              {step.kind === 'read'
                                ? Array.isArray(step.rows)
                                  ? `${step.rows.length} row(s)`
                                  : 'read statement executed'
                                : typeof step.rowsAffected === 'number'
                                  ? `${step.rowsAffected} row(s) affected`
                                  : 'statement executed'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex items-start gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg text-sm">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span className="font-mono text-xs whitespace-pre-wrap">{result.error}</span>
            </div>
          )
        ) : (
           <div className="h-full flex items-center justify-center text-zinc-600 text-sm">
             Enter a SQL query and press Run.
           </div>
        )}
      </div>
    </div>
  );
}

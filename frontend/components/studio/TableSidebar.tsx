"use client";

import { useMemo, useState } from 'react';
import { Search, RotateCw, LayoutGrid } from 'lucide-react';

type TableInfo = {
  table: string;
  kind: 'table' | 'view';
  rowCount: number;
  columns: Array<{ name: string; type: string; pk: number }>;
};

type Props = {
  tables: TableInfo[];
  activeTable: string | null;
  activeKind: 'table' | 'view';
  activeTab: 'data' | 'sql';
  onSelectTable: (table: string) => void;
  onSelectKind: (kind: 'table' | 'view') => void;
  onSelectTab: (tab: 'data' | 'sql') => void;
  onRefresh: () => void;
  loading?: boolean;
};

export function TableSidebar({ tables, activeTable, activeKind, activeTab, onSelectTable, onSelectKind, onSelectTab, onRefresh, loading = false }: Props) {
  const [query, setQuery] = useState('');

  const visibleTables = useMemo(
    () => tables.filter((table) => table.kind === activeKind && table.table.toLowerCase().includes(query.toLowerCase())),
    [tables, query, activeKind],
  );

  return (
    <div className="w-64 flex-shrink-0 bg-[#09090b] border-r border-zinc-800/80 flex flex-col h-full text-[13px]">
      <div className="p-4 flex flex-col gap-4">
        <button 
          onClick={() => onSelectTab('sql')}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-md transition-colors text-left ${
            activeTab === 'sql' 
              ? 'bg-zinc-800/80 text-zinc-100' 
              : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
          }`}
        >
          <div className="w-4 h-4 rounded-sm border border-zinc-500 flex items-center justify-center text-[10px] font-mono">_</div>
          <span className="font-medium">SQL console</span>
        </button>

        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">Schema</span>
          <button 
            type="button" 
            onClick={onRefresh} 
            className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded hover:bg-zinc-800"
            title="Refresh schema"
          >
            <RotateCw size={14} />
          </button>
        </div>

        <div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
            <input
              type="text"
              placeholder="Search tables"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-[#18181b] border border-zinc-800 rounded-lg pl-9 pr-3 py-1.5 text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600 transition-colors"
            />
          </div>
          <div className="text-[11px] text-zinc-600 mt-2 font-medium">
            {visibleTables.length} table{visibleTables.length !== 1 ? 's' : ''}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onSelectKind('table')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${activeKind === 'table' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Tables
          </button>
          <button
            type="button"
            onClick={() => onSelectKind('view')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${activeKind === 'view' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Views
          </button>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4 custom-scrollbar">
        {loading ? (
          <div className="flex flex-col gap-1.5 px-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2.5 rounded-md" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="flex items-center gap-2">
                  <div className="skeleton w-4 h-4 rounded"></div>
                  <div className="skeleton skeleton-text" style={{ width: `${60 + Math.random() * 60}px` }}></div>
                </div>
                <div className="skeleton skeleton-text-sm w-5"></div>
              </div>
            ))}
          </div>
        ) : visibleTables.length === 0 ? (
          <div className="px-3 py-2 text-zinc-500 text-xs text-center animate-fadeIn">No {activeKind === 'table' ? 'tables' : 'views'} found</div>
        ) : null}
        {!loading && <div className="flex flex-col gap-0.5">
          {visibleTables.map((t, i) => (
            <button
              type="button"
              key={t.table}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-md transition-all text-left stagger-item ${
                activeTab === 'data' && activeTable === t.table 
                  ? 'bg-zinc-800/80 text-zinc-100' 
                  : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
              }`}
              style={{ animationDelay: `${i * 30}ms` }}
              onClick={() => {
                onSelectTable(t.table);
                onSelectTab('data');
              }}
            >
              <div className="flex items-center gap-2 overflow-hidden">
                <LayoutGrid size={14} className={activeTab === 'data' && activeTable === t.table ? 'text-zinc-300' : 'text-zinc-500'} />
                <span className="font-medium truncate">{t.table}</span>
              </div>
              <span className={`text-[10px] font-mono ${activeTable === t.table ? 'text-zinc-400' : 'text-zinc-600'}`}>
                {t.rowCount}
              </span>
            </button>
          ))}
        </div>}
      </nav>
    </div>
  );
}

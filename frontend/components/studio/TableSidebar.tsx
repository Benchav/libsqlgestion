"use client";

import { useMemo, useState } from 'react';

type TableInfo = {
  table: string;
  columns: Array<{ name: string; type: string; pk: number }>;
};

type Props = {
  tables: TableInfo[];
  activeTable: string | null;
  onSelect: (table: string) => void;
  onRefresh: () => void;
};

export function TableSidebar({ tables, activeTable, onSelect, onRefresh }: Props) {
  const [query, setQuery] = useState('');

  const visibleTables = useMemo(
    () => tables.filter((table) => table.table.toLowerCase().includes(query.toLowerCase())),
    [tables, query],
  );

  return (
    <div className="studio-sidebar">
      <div className="studio-sidebar-header">
        <span className="studio-sidebar-title">Schema</span>
        <button type="button" className="studio-icon-btn" onClick={onRefresh} title="Refresh schema">
          ↻
        </button>
      </div>
      <div className="studio-sidebar-search">
        <div className="studio-sidebar-searchbox">
          <span className="studio-sidebar-search-icon">⌕</span>
          <input
            type="text"
            placeholder="Search tables"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="studio-sidebar-count">{visibleTables.length} table{visibleTables.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="studio-sidebar-pills">
        <span className="studio-sidebar-pill active">Tables</span>
        <span className="studio-sidebar-pill">Views</span>
      </div>
      <nav className="studio-sidebar-nav">
        {visibleTables.length === 0 && (
          <div className="studio-sidebar-empty">No tables found</div>
        )}
        {visibleTables.map((t) => (
          <button
            type="button"
            key={t.table}
            className={`studio-sidebar-item ${activeTable === t.table ? 'active' : ''}`}
            onClick={() => onSelect(t.table)}
          >
            <span className="studio-sidebar-item-icon">⊞</span>
            <span className="studio-sidebar-item-name">{t.table}</span>
            <span className="studio-sidebar-item-cols">{t.columns.length}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

"use client";

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
  return (
    <div className="studio-sidebar">
      <div className="studio-sidebar-header">
        <span className="studio-sidebar-title">Tables</span>
        <button className="studio-icon-btn" onClick={onRefresh} title="Refresh schema">
          ↻
        </button>
      </div>
      <div className="studio-sidebar-search">
        {/* Simple count label */}
        <span className="studio-sidebar-count">{tables.length} table{tables.length !== 1 ? 's' : ''}</span>
      </div>
      <nav className="studio-sidebar-nav">
        {tables.length === 0 && (
          <div className="studio-sidebar-empty">No tables found</div>
        )}
        {tables.map((t) => (
          <button
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

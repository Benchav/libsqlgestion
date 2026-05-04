"use client";

import { useState, useCallback, useRef, useEffect } from 'react';

type ColumnMeta = { name: string; type: string; notnull: number; pk: number };

type Props = {
  tableName: string;
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onSort: (column: string, dir: 'ASC' | 'DESC') => void;
  sortColumn: string | null;
  sortDir: 'ASC' | 'DESC';
  onCellEdit: (rowIndex: number, column: string, value: unknown) => void;
  onDeleteRow: (rowIndex: number) => void;
  onAddRow: () => void;
  loading: boolean;
};

export function DataGrid({
  tableName,
  columns,
  rows,
  totalRows,
  page,
  pageSize,
  onPageChange,
  onSort,
  sortColumn,
  sortDir,
  onCellEdit,
  onDeleteRow,
  onAddRow,
  loading,
}: Props) {
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  const handleStartEdit = useCallback((rowIdx: number, colName: string, currentValue: unknown) => {
    setEditingCell({ row: rowIdx, col: colName });
    setEditValue(currentValue === null ? '' : String(currentValue));
  }, []);

  const handleCommitEdit = useCallback(() => {
    if (editingCell) {
      onCellEdit(editingCell.row, editingCell.col, editValue === '' ? null : editValue);
      setEditingCell(null);
    }
  }, [editingCell, editValue, onCellEdit]);

  const handleCancelEdit = useCallback(() => {
    setEditingCell(null);
  }, []);

  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingCell]);

  const handleHeaderClick = useCallback((colName: string) => {
    if (sortColumn === colName) {
      onSort(colName, sortDir === 'ASC' ? 'DESC' : 'ASC');
    } else {
      onSort(colName, 'ASC');
    }
  }, [sortColumn, sortDir, onSort]);

  const typeColor = useCallback((type: string) => {
    const t = type.toUpperCase();
    if (t.includes('INT')) return 'var(--studio-accent)';
    if (t.includes('TEXT') || t.includes('VARCHAR') || t.includes('CHAR')) return '#a78bfa';
    if (t.includes('REAL') || t.includes('FLOAT') || t.includes('DOUBLE')) return '#f59e0b';
    if (t.includes('BLOB')) return '#ef4444';
    if (t.includes('DATE') || t.includes('TIME')) return '#10b981';
    return 'var(--studio-muted)';
  }, []);

  const formatCell = useCallback((value: unknown) => {
    if (value === null || value === undefined) return <span className="studio-null">NULL</span>;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const s = String(value);
    if (s.length > 120) return s.slice(0, 120) + '…';
    return s;
  }, []);

  return (
    <div className="studio-datagrid">
      {/* Toolbar */}
      <div className="studio-grid-toolbar">
        <div className="studio-grid-toolbar-left">
          <span className="studio-grid-table-name">⊞ {tableName}</span>
          <span className="studio-grid-count">{totalRows} row{totalRows !== 1 ? 's' : ''}</span>
        </div>
        <div className="studio-grid-toolbar-right">
          <button type="button" className="studio-btn studio-btn-primary" onClick={onAddRow} title="Insert row">
            + Add row
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="studio-grid-scroll">
        <table className="studio-table">
          <thead>
            <tr>
              <th className="studio-th-row-num">#</th>
              {columns.map((col) => (
                <th
                  key={col.name}
                  className="studio-th"
                  onClick={() => handleHeaderClick(col.name)}
                >
                  <div className="studio-th-content">
                    <span className="studio-th-name">
                      {col.pk ? <span className="studio-pk-icon" title="Primary key">🔑</span> : null}
                      {col.name}
                    </span>
                    <span className="studio-th-type" style={{ color: typeColor(col.type) }}>
                      {col.type || 'ANY'}
                    </span>
                    {sortColumn === col.name && (
                      <span className="studio-sort-indicator">{sortDir === 'ASC' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
              ))}
              <th className="studio-th-actions">⋮</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length + 2} className="studio-loading-cell">
                  Loading data…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} className="studio-empty-cell">
                  No data. Click "+ Add row" to insert.
                </td>
              </tr>
            ) : (
              rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="studio-tr">
                  <td className="studio-td-row-num">{page * pageSize + rowIdx + 1}</td>
                  {columns.map((col) => {
                    const isEditing = editingCell?.row === rowIdx && editingCell?.col === col.name;
                    const cellValue = row[col.name];
                    return (
                      <td
                        key={col.name}
                        className={`studio-td ${isEditing ? 'studio-td-editing' : ''} ${cellValue === null ? 'studio-td-null' : ''}`}
                        onDoubleClick={() => handleStartEdit(rowIdx, col.name, cellValue)}
                      >
                        {isEditing ? (
                          <input
                            ref={inputRef}
                            className="studio-cell-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleCommitEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleCommitEdit();
                              if (e.key === 'Escape') handleCancelEdit();
                              if (e.key === 'Tab') {
                                e.preventDefault();
                                handleCommitEdit();
                              }
                            }}
                          />
                        ) : (
                          <span className="studio-cell-value">{formatCell(cellValue)}</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="studio-td-actions">
                    <button
                      type="button"
                      className="studio-row-delete"
                      onClick={() => onDeleteRow(rowIdx)}
                      title="Delete row"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="studio-pagination">
        <button
          className="studio-btn"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          ← Prev
        </button>
        <span className="studio-pagination-info">
          Page {page + 1} of {totalPages}
        </span>
        <button
          className="studio-btn"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

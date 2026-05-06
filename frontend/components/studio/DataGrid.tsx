"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { LayoutGrid, Database, ChevronLeft, ChevronRight, Filter, ArrowUpDown, Columns, Plus, MoreVertical, Key, X, Pencil } from 'lucide-react';

type ColumnMeta = { name: string; type: string; notnull: number; pk: number };

function getColumnInputKind(column: ColumnMeta): 'text' | 'number' | 'date' | 'datetime-local' | 'checkbox' {
  const type = (column.type || '').toUpperCase();
  if (type.includes('BOOL')) return 'checkbox';
  if (type.includes('DATE') && !type.includes('TIME')) return 'date';
  if (type.includes('TIME') || type.includes('TIMESTAMP')) return 'datetime-local';
  if (type.includes('INT') || type.includes('REAL') || type.includes('FLOAT') || type.includes('DOUBLE') || type.includes('NUMERIC') || type.includes('DECIMAL')) {
    return 'number';
  }
  return 'text';
}

function isTruthyValue(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

type Props = {
  tableName: string;
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  totalRows: number;
  readOnly?: boolean;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onSort: (column: string, dir: 'ASC' | 'DESC') => void;
  sortColumn: string | null;
  sortDir: 'ASC' | 'DESC';
  onCellEdit: (rowIndex: number, column: string, value: unknown) => void;
  onEditRow: (rowIndex: number) => void;
  onDeleteRow: (rowIndex: number) => void;
  onAddRow: () => void;
  onInsertRow: () => void;
  loading: boolean;
};

export function DataGrid({
  tableName,
  columns,
  rows,
  totalRows,
  readOnly = false,
  page,
  pageSize,
  onPageChange,
  onSort,
  sortColumn,
  sortDir,
  onCellEdit,
  onEditRow,
  onDeleteRow,
  onAddRow,
  onInsertRow,
  loading,
}: Props) {
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const commitLockRef = useRef(false);

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  const handleStartEdit = useCallback((rowIdx: number, colName: string, currentValue: unknown) => {
    const column = columns.find((col) => col.name === colName);
    setEditingCell({ row: rowIdx, col: colName });
    if (column && getColumnInputKind(column) === 'checkbox') {
      setEditValue(currentValue === null || currentValue === undefined ? '' : (isTruthyValue(currentValue) ? '1' : '0'));
      return;
    }
    setEditValue(currentValue === null || currentValue === undefined ? '' : String(currentValue));
  }, [columns]);

  const handleCommitEdit = useCallback(() => {
    if (commitLockRef.current) return;
    if (editingCell) {
      commitLockRef.current = true;
      onCellEdit(editingCell.row, editingCell.col, editValue === '' ? null : editValue);
      setEditingCell(null);
      window.setTimeout(() => {
        commitLockRef.current = false;
      }, 0);
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

  const getTypeColor = useCallback((type: string) => {
    const t = type.toUpperCase();
    if (t.includes('INT')) return 'text-blue-400';
    if (t.includes('TEXT') || t.includes('VARCHAR') || t.includes('CHAR')) return 'text-purple-400';
    if (t.includes('REAL') || t.includes('FLOAT') || t.includes('DOUBLE')) return 'text-amber-400';
    if (t.includes('BLOB')) return 'text-red-400';
    if (t.includes('DATE') || t.includes('TIME')) return 'text-emerald-400';
    return 'text-zinc-500';
  }, []);

  const formatCell = useCallback((value: unknown) => {
    if (value === null || value === undefined) return <span className="text-zinc-600 font-mono text-[11px]">NULL</span>;
    if (typeof value === 'boolean') return <span className="text-blue-400 font-mono text-[11px]">{value ? 'true' : 'false'}</span>;
    const s = String(value);
    if (s.length > 120) return s.slice(0, 120) + '…';
    return s;
  }, []);

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] text-[13px]">
      {/* Studio Toolbar (Top) */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/80 bg-[#09090b]">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <LayoutGrid size={16} className="text-zinc-200" />
            <span className="font-semibold text-zinc-100">{tableName}</span>
            <span className="text-xs text-zinc-500 ml-1">{totalRows} rows</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center border border-zinc-800 rounded-md overflow-hidden bg-zinc-900/50 mr-2">
            <button 
              className="px-2 py-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
              disabled={page === 0}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeft size={14} />
            </button>
            <div className="px-3 text-xs text-zinc-400 font-medium border-x border-zinc-800 bg-zinc-900">
              {totalRows === 0 ? '0' : `${page * pageSize + 1} - ${Math.min((page + 1) * pageSize, totalRows)}`} of {totalRows}
            </div>
            <button 
              className="px-2 py-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
              disabled={page >= totalPages - 1}
              onClick={() => onPageChange(page + 1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>

          <div className="flex items-center gap-1 mr-2">
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-zinc-300 hover:bg-zinc-800 transition-colors border border-transparent hover:border-zinc-700 text-xs font-medium">
              <Filter size={14} className="text-zinc-500" /> Filters
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-zinc-300 hover:bg-zinc-800 transition-colors border border-transparent hover:border-zinc-700 text-xs font-medium">
              <ArrowUpDown size={14} className="text-zinc-500" /> Sort
            </button>
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-zinc-300 hover:bg-zinc-800 transition-colors border border-transparent hover:border-zinc-700 text-xs font-medium">
              <Columns size={14} className="text-zinc-500" /> Columns
            </button>
          </div>

          {!readOnly && (
            <>
              <button 
                onClick={onAddRow}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition-colors text-xs font-medium"
              >
                <Plus size={14} /> Quick add
              </button>

              <button
                onClick={onInsertRow}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/20 transition-colors text-xs font-medium"
              >
                <Plus size={14} /> Insert row
              </button>
            </>
          )}
        </div>
      </div>

      {/* Grid Area */}
      <div className="flex-1 overflow-auto custom-scrollbar relative">
        <table className="min-w-max w-full text-left border-collapse whitespace-nowrap table-auto">
          <thead className="sticky top-0 z-10 bg-[#09090b]">
            <tr>
              <th className="w-10 border-b border-r border-zinc-800 py-1.5 px-2 text-center text-zinc-500 font-medium text-xs bg-[#09090b]">
                #
              </th>
              {columns.map((col) => (
                <th
                  key={col.name}
                  className="border-b border-r border-zinc-800 py-1.5 px-3 bg-[#09090b] cursor-pointer hover:bg-zinc-800/50 transition-colors group select-none min-w-[160px]"
                  onClick={() => handleHeaderClick(col.name)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 overflow-hidden">
                      {col.pk ? <Key size={12} className="text-amber-500 shrink-0" /> : null}
                      <span className="font-semibold text-zinc-200 text-xs">{col.name}</span>
                      <span className={`text-[10px] uppercase font-mono tracking-wider ${getTypeColor(col.type)}`}>
                        {col.type || 'ANY'}
                      </span>
                    </div>
                    {sortColumn === col.name ? (
                      <ArrowUpDown size={12} className="text-zinc-400 shrink-0 ml-2" />
                    ) : (
                      <ArrowUpDown size={12} className="text-zinc-600 opacity-0 group-hover:opacity-100 shrink-0 ml-2" />
                    )}
                  </div>
                </th>
              ))}
              <th className="w-10 border-b border-zinc-800 py-1.5 px-2 text-center text-zinc-500 bg-[#09090b]">
                <MoreVertical size={14} className="mx-auto" />
              </th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs">
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`skel-${i}`} className="border-b border-zinc-800/40" style={{ animationDelay: `${i * 40}ms` }}>
                  <td className="w-10 border-r border-zinc-800/40 py-2 px-2 text-center">
                    <div className="skeleton skeleton-text-sm w-4 mx-auto"></div>
                  </td>
                  {columns.map((col) => (
                    <td key={col.name} className="border-r border-zinc-800/40 px-3 py-2">
                      <div className={`skeleton skeleton-text`} style={{ width: `${45 + Math.random() * 40}%` }}></div>
                    </td>
                  ))}
                  <td className="w-10 py-2 px-2"></td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} className="py-12 text-center font-sans animate-fadeIn">
                  <div className="flex flex-col items-center gap-2">
                    <Database size={24} className="text-zinc-700" />
                    <span className="text-zinc-500 text-sm">No data. Click &quot;+ Quick add&quot; or &quot;+ Insert row&quot; to insert.</span>
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="hover:bg-zinc-800/40 group border-b border-zinc-800/40">
                  <td className="w-10 border-r border-zinc-800/40 py-1.5 px-2 text-center text-zinc-600 text-[10px]">
                    {page * pageSize + rowIdx + 1}
                  </td>
                  {columns.map((col) => {
                    const isEditing = editingCell?.row === rowIdx && editingCell?.col === col.name;
                    const cellValue = row[col.name];
                    return (
                      <td
                        key={col.name}
                        className={`border-r border-zinc-800/40 px-3 py-1 text-zinc-300 relative
                          ${isEditing ? 'bg-blue-500/10 ring-1 ring-inset ring-blue-500 z-10' : ''} 
                          ${cellValue === null && !isEditing ? 'bg-zinc-900/20' : ''}`}
                        onDoubleClick={() => {
                          if (!readOnly) handleStartEdit(rowIdx, col.name, cellValue);
                        }}
                      >
                        {isEditing && !readOnly ? (
                              getColumnInputKind(col) === 'checkbox' ? (
                                <label className="absolute inset-0 flex items-center gap-2 px-3 bg-transparent text-zinc-100">
                                  <input
                                    ref={inputRef}
                                    type="checkbox"
                                    checked={isTruthyValue(editValue)}
                                    onChange={(e) => {
                                      if (commitLockRef.current) return;
                                      commitLockRef.current = true;
                                      onCellEdit(rowIdx, col.name, e.target.checked ? '1' : '0');
                                      setEditingCell(null);
                                      window.setTimeout(() => {
                                        commitLockRef.current = false;
                                      }, 0);
                                    }}
                                    onBlur={handleCommitEdit}
                                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500"
                                  />
                                  <span className="font-sans text-[11px] text-zinc-400">{isTruthyValue(editValue) ? 'true' : 'false'}</span>
                                </label>
                              ) : (
                                <input
                                  ref={inputRef}
                                  type={getColumnInputKind(col)}
                                  step={getColumnInputKind(col) === 'number' ? 'any' : undefined}
                                  className="absolute inset-0 w-full h-full bg-transparent px-3 font-mono text-xs text-zinc-100 focus:outline-none placeholder:text-zinc-600"
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
                                  placeholder={cellValue === null ? 'NULL' : ''}
                                />
                              )
                            ) : (
                          <div className="truncate min-h-[18px] flex items-center">
                            {formatCell(cellValue)}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  {!readOnly ? (
                    <td className="w-10 py-1 px-2 text-center">
                      <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                        <button
                          type="button"
                          className="rounded p-1 text-zinc-600 transition-colors hover:bg-blue-500/10 hover:text-blue-400"
                          onClick={() => onEditRow(rowIdx)}
                          title="Edit row"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-zinc-600 transition-colors hover:bg-red-500/10 hover:text-red-400"
                          onClick={() => onDeleteRow(rowIdx)}
                          title="Delete row"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </td>
                  ) : (
                    <td className="w-10 py-1 px-2 text-center text-zinc-600 text-[10px]">view</td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

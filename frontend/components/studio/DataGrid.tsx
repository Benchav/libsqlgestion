"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { LayoutGrid, Database, ChevronLeft, ChevronRight, Filter, ArrowUpDown, Columns, Plus, MoreVertical, Key, X } from 'lucide-react';

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

          <button 
            onClick={onAddRow}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition-colors text-xs font-medium"
          >
            <Plus size={14} /> Add row
          </button>
        </div>
      </div>

      {/* Grid Area */}
      <div className="flex-1 overflow-auto custom-scrollbar relative">
        <table className="w-full text-left border-collapse whitespace-nowrap table-fixed">
          <thead className="sticky top-0 z-10 bg-[#09090b]">
            <tr>
              <th className="w-10 border-b border-r border-zinc-800 py-1.5 px-2 text-center text-zinc-500 font-medium text-xs bg-[#09090b]">
                #
              </th>
              {columns.map((col) => (
                <th
                  key={col.name}
                  className="border-b border-r border-zinc-800 py-1.5 px-3 bg-[#09090b] cursor-pointer hover:bg-zinc-800/50 transition-colors group select-none min-w-[120px]"
                  onClick={() => handleHeaderClick(col.name)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 overflow-hidden">
                      {col.pk ? <Key size={12} className="text-amber-500 shrink-0" /> : null}
                      <span className="font-semibold text-zinc-200 text-xs truncate">{col.name}</span>
                      <span className={`text-[10px] uppercase font-mono tracking-wider ${getTypeColor(col.type)} truncate`}>
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
              <tr>
                <td colSpan={columns.length + 2} className="py-8 text-center text-zinc-500 font-sans">
                  Loading data...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} className="py-8 text-center text-zinc-500 font-sans">
                  No data. Click "+ Add row" to insert.
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
                        className={`border-r border-zinc-800/40 px-3 py-1 text-zinc-300 relative truncate
                          ${isEditing ? 'bg-blue-500/10 ring-1 ring-inset ring-blue-500 z-10' : ''} 
                          ${cellValue === null && !isEditing ? 'bg-zinc-900/20' : ''}`}
                        onDoubleClick={() => handleStartEdit(rowIdx, col.name, cellValue)}
                      >
                        {isEditing ? (
                          <input
                            ref={inputRef}
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
                        ) : (
                          <div className="truncate min-h-[18px] flex items-center">
                            {formatCell(cellValue)}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td className="w-10 py-1 px-2 text-center">
                    <button
                      type="button"
                      className="text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all p-1 rounded hover:bg-red-500/10"
                      onClick={() => onDeleteRow(rowIdx)}
                      title="Delete row"
                    >
                      <X size={14} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import { useState, useRef, useEffect } from 'react';

type Props = {
  onExecute: (sql: string) => void;
  loading: boolean;
  result: {
    ok: boolean;
    rows?: unknown[];
    error?: string;
    changes?: number;
  } | null;
};

export function SqlRunner({ onExecute, loading, result }: Props) {
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
    <div className="studio-sql-runner">
      <div className="studio-sql-header">
        <span className="studio-sql-title">▷ SQL Runner</span>
        <div className="studio-sql-actions">
          <button type="button" className="studio-btn studio-btn-primary" onClick={handleRun} disabled={loading || !sql.trim()}>
            {loading ? 'Running…' : '▶ Execute'}
          </button>
          <span className="studio-sql-hint">Ctrl+Enter</span>
        </div>
      </div>

      <textarea
        ref={textareaRef}
        className="studio-sql-textarea"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        placeholder="SELECT * FROM your_table LIMIT 50;"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            handleRun();
          }
        }}
        spellCheck={false}
      />

      {/* Results */}
      {result && (
        <div className="studio-sql-results">
          {result.ok ? (
            <>
              {result.rows && result.rows.length > 0 ? (
                <div className="studio-sql-results-table">
                  <div className="studio-sql-results-count">
                    ✓ {result.rows.length} row{result.rows.length !== 1 ? 's' : ''} returned
                  </div>
                  <div className="studio-grid-scroll studio-sql-results-scroll">
                    <table className="studio-table">
                      <thead>
                        <tr>
                          {Object.keys(result.rows[0] as object).map((key) => (
                            <th key={key} className="studio-th">
                              <div className="studio-th-content">
                                <span className="studio-th-name">{key}</span>
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row: any, i) => (
                          <tr key={i} className="studio-tr">
                            {Object.values(row).map((val: any, j) => (
                              <td key={j} className={`studio-td ${val === null ? 'studio-td-null' : ''}`}>
                                <span className="studio-cell-value">
                                  {val === null ? <span className="studio-null">NULL</span> : String(val)}
                                </span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="studio-sql-success">
                  ✓ Query executed successfully{result.changes !== undefined ? ` (${result.changes} rows affected)` : ''}
                </div>
              )}
            </>
          ) : (
            <div className="studio-sql-error">{result.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

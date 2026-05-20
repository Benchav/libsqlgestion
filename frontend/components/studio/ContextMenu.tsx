"use client";

import { ReactNode, useEffect } from 'react';

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
};

type Props = {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

export function ContextMenu({ open, x, y, items, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const width = 208;
  const height = Math.max(44, items.length * 36 + 8);
  const padding = 8;
  const left = Math.min(x, Math.max(padding, window.innerWidth - width - padding));
  const top = Math.min(y, Math.max(padding, window.innerHeight - height - padding));

  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        className="fixed min-w-52 rounded-xl border border-zinc-800 bg-[#111114] py-1 shadow-2xl shadow-black/40"
        style={{ left, top }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {items.map((item) => (
          <div key={item.label}>
            {item.separatorBefore && <div className="my-1 border-t border-zinc-800/90" />}
            <button
              type="button"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onClick();
                onClose();
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger ? 'text-red-300 hover:bg-red-500/10' : 'text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              {item.icon ? <span className="text-zinc-500">{item.icon}</span> : <span className="w-3" />}
              <span>{item.label}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import { ReactNode } from 'react';

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
};

type Props = {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

export function ContextMenu({ open, x, y, items, onClose }: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        className="fixed min-w-52 rounded-xl border border-zinc-800 bg-[#111114] py-1 shadow-2xl shadow-black/40"
        style={{ left: x, top: y }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {items.map((item) => (
          <button
            key={item.label}
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
        ))}
      </div>
    </div>
  );
}

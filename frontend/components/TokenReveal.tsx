"use client";

import { useState } from 'react';
import { Copy, Check, Eye, X } from 'lucide-react';

type TokenRevealProps = {
  token: string;
  label?: string;
  onDismiss?: () => void;
};

export function TokenReveal({ token, label = 'Auth Token', onDismiss }: TokenRevealProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="border border-amber-500/20 bg-amber-500/5 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 text-amber-300 text-sm font-medium">
        <div className="flex items-center gap-2">
          <Eye size={14} />
          {label} shown once
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center gap-1.5 text-xs text-amber-200/80 hover:text-amber-100 transition-colors"
            aria-label="Hide token"
          >
            <X size={14} />
            Hide
          </button>
        )}
      </div>
      <div className="flex items-center gap-3 bg-[#050505] border border-zinc-800 rounded-lg p-3">
        <code className="flex-1 font-mono text-xs text-zinc-100 break-all whitespace-normal">{token}</code>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-medium transition-colors"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-xs text-zinc-400">
        Save this token now. It will not be shown again after you leave this screen.
      </p>
    </div>
  );
}
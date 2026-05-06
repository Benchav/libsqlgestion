"use client";

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../lib/useAuth';
import { apiRequest } from '../lib/api';
import { 
  Database, Activity, FileText, CreditCard, Settings, HelpCircle, 
  ChevronDown, ChevronRight, Search, Plus, RefreshCw, LayoutList, 
  Filter, ArrowUpDown, Columns, MoreHorizontal, Copy, Moon, 
  Sidebar as SidebarIcon, Terminal, Table2, Clock, History, Check, X
} from 'lucide-react';

function ChevronUpDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
      <path d="m7 15 5 5 5-5"/>
      <path d="m7 9 5-5 5 5"/>
    </svg>
  );
}

function TopBar({ isSidebarOpen, setIsSidebarOpen }: { isSidebarOpen: boolean, setIsSidebarOpen: (v: boolean) => void }) {
  const pathname = usePathname();
  const router = useRouter();
  
  const getBreadcrumbs = () => {
    if (pathname === '/dashboard') return <span className="text-zinc-100 font-medium">Dashboard</span>;
    if (pathname?.startsWith('/projects')) return <span className="text-zinc-100 font-medium">Projects</span>;
    if (pathname?.startsWith('/audit')) return <span className="text-zinc-100 font-medium">Audit Logs</span>;
    if (pathname?.startsWith('/settings')) return <span className="text-zinc-100 font-medium">Settings</span>;
    if (pathname?.includes('/studio')) {
      return (
        <>
          <span className="text-zinc-400 cursor-pointer hover:text-zinc-200 transition-colors" onClick={() => router.push('/databases')}>Databases</span>
          <ChevronRight className="text-zinc-600 mx-1" size={14} />
          <div className="flex bg-zinc-900/80 rounded-md border border-zinc-800 p-0.5">
            <button className="px-3 py-1 text-xs font-medium text-zinc-100 bg-zinc-800 rounded shadow-sm">Studio</button>
          </div>
        </>
      );
    }
    if (pathname?.startsWith('/databases')) return <span className="text-zinc-100 font-medium">Databases</span>;
    return null;
  };

  return (
    <header className="h-14 border-b border-zinc-800/60 flex items-center px-4 shrink-0 bg-[#0a0a0a]/80 backdrop-blur-sm sticky top-0 z-10">
      <div className="flex items-center gap-3">
        <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="text-zinc-400 hover:text-zinc-200">
          <SidebarIcon size={18} />
        </button>
        <div className="h-4 w-px bg-zinc-800"></div>
        <div className="flex items-center text-sm">
          <span className="text-zinc-400 cursor-pointer hover:text-zinc-200" onClick={() => router.push('/dashboard')}>libsqlite</span>
          <ChevronRight className="text-zinc-600 mx-2" size={14} />
          {getBreadcrumbs()}
        </div>
      </div>
    </header>
  );
}

function Sidebar({ onOpenCreateDb }: { onOpenCreateDb: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  
  const [dbOpen, setDbOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(pathname?.startsWith('/settings'));

  const navItems = [
    { id: 'projects', href: '/projects', icon: Activity, label: 'Projects' },
    { id: 'audit', href: '/audit', icon: History, label: 'Audit Logs' },
  ];

  return (
    <aside className="w-64 flex-shrink-0 border-r border-zinc-800/60 bg-[#0f0f0f] flex flex-col h-full transition-all duration-300">
      <div className="p-4 flex items-center justify-between hover:bg-zinc-800/30 cursor-pointer rounded-lg mx-2 mt-2 transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-zinc-800 flex items-center justify-center">
            <Database className="text-zinc-100" size={14} />
          </div>
          <div>
            <div className="font-semibold text-zinc-100 text-sm">Organización</div>
            <div className="text-xs text-zinc-500">Plan Local</div>
          </div>
        </div>
        <ChevronUpDownIcon />
      </div>

      <div className="px-4 py-2 flex flex-col gap-2">
        <button onClick={onOpenCreateDb} className="w-full bg-zinc-100 hover:bg-white text-zinc-900 font-medium py-1.5 rounded-md transition-colors text-[13px]">
          Create Database
        </button>
        <button onClick={() => router.push('/projects')} className="w-full bg-transparent hover:bg-zinc-800 border border-zinc-800 text-zinc-300 font-medium py-1.5 rounded-md transition-colors text-[13px]">
          Manage Projects
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-4 custom-scrollbar flex flex-col gap-0.5">
        <div className="px-3 py-1.5 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">Local Cloud</div>
        
        <div>
          <button 
            onClick={() => {
              setDbOpen(!dbOpen);
              router.push('/databases');
            }}
            className={`w-full flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-zinc-800/50 transition-colors ${pathname?.startsWith('/databases') ? 'bg-zinc-800/40 text-zinc-100' : 'text-zinc-400'}`}
          >
            <div className="flex items-center gap-2">
              <Database size={16} className={pathname?.startsWith('/databases') ? 'text-zinc-100' : ''} />
              <span>Databases</span>
            </div>
            {dbOpen ? <ChevronDown className="text-zinc-500" size={14} /> : <ChevronRight className="text-zinc-500" size={14} />}
          </button>
          
          {dbOpen && (
            <div className="ml-6 mt-1 flex flex-col gap-1">
              <button onClick={() => router.push('/databases')} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-zinc-800/60 text-zinc-100 text-sm">
                <span className="w-4 h-3 flex items-center justify-center">
                  <span className="w-2 h-2 rounded-full bg-blue-400/20 border border-blue-400/50 block"></span>
                </span>
                <span>All Databases</span>
              </button>
            </div>
          )}
        </div>

        <button onClick={() => router.push('/dashboard')} className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-zinc-800/50 transition-colors ${pathname === '/dashboard' ? 'bg-zinc-800/40 text-zinc-100' : 'text-zinc-400'}`}>
          <LayoutList size={16} />
          <span>Dashboard</span>
        </button>

        {navItems.map(item => (
          <button key={item.id} onClick={() => router.push(item.href)} className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-zinc-800/50 transition-colors ${pathname?.startsWith(item.href) ? 'bg-zinc-800/40 text-zinc-100' : 'text-zinc-400'}`}>
            <item.icon size={16} />
            <span>{item.label}</span>
          </button>
        ))}

        <div>
          <button onClick={() => { setSettingsOpen(!settingsOpen); router.push('/settings'); }} className={`w-full flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-zinc-800/50 transition-colors ${pathname?.startsWith('/settings') ? 'bg-zinc-800/40 text-zinc-100' : 'text-zinc-400'}`}>
            <div className="flex items-center gap-2">
              <Settings size={16} />
              <span>Settings</span>
            </div>
            {settingsOpen ? <ChevronDown className="text-zinc-500" size={14} /> : <ChevronRight className="text-zinc-500" size={14} />}
          </button>
        </div>
      </nav>

      <div className="p-4 border-t border-zinc-800/60 flex items-center justify-between">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center overflow-hidden shrink-0">
             <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.email || 'Admin'}&backgroundColor=27272a`} alt="User" className="w-full h-full" />
          </div>
          <span className="text-xs text-zinc-400 truncate">{user?.email}</span>
        </div>
        <button 
          onClick={async () => {
            await apiRequest('/auth/logout', { method: 'POST' }).catch(() => undefined);
            window.location.href = '/login';
          }}
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
          title="Sign out"
        >
          <Moon size={16} />
        </button>
      </div>
    </aside>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const router = useRouter();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0a0a]">
        <div className="flex flex-col items-center gap-4 animate-fadeIn">
          <div className="relative">
            <div className="w-12 h-12 rounded-xl bg-zinc-800/50 flex items-center justify-center">
              <Database className="text-zinc-400 pulse-glow" size={24} />
            </div>
            <div className="absolute -bottom-1 -right-1 spinner spinner-sm border-top-color-emerald" style={{ borderTopColor: '#34d399' }}></div>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-sm font-medium text-zinc-300">Loading control plane</span>
            <span className="text-xs text-zinc-600">Initializing session…</span>
          </div>
        </div>
      </div>
    );
  }

  // Si no hay usuario y no está cargando, useAuth hace redirect, pero mostramos vacío mientras.
  if (!user) return null;

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-zinc-300 font-sans text-[13px] selection:bg-emerald-500/30 overflow-hidden relative">
      {isSidebarOpen && (
        <Sidebar 
          onOpenCreateDb={() => router.push('/databases')} 
        />
      )}
      
      <div className="flex-1 flex flex-col h-full min-w-0">
        <TopBar isSidebarOpen={isSidebarOpen} setIsSidebarOpen={setIsSidebarOpen} />
        
        <main className="flex-1 overflow-auto relative custom-scrollbar">
          {children}
        </main>
      </div>
    </div>
  );
}

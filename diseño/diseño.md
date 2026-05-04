# Especificación de Diseño Frontend (Turso-Clone UI)

## Contexto para el Agente (Google Antigravity)
Eres un desarrollador frontend experto trabajando en un panel de control (dashboard) para un servicio de bases de datos autoalojado. Tu objetivo es descartar el diseño anterior del frontend e implementar estrictamente la nueva interfaz de usuario detallada en este documento. 

Este proyecto utiliza **React** y **Tailwind CSS**. Debes mantener una arquitectura de componentes limpios, utilizando el siguiente código como la **fuente única de la verdad** para la capa de presentación.

## 1. Sistema de Diseño (Design System)

### 1.1 Paleta de Colores
El diseño sigue una temática oscura (Dark Mode Premium) basada principalmente en la paleta `zinc` de Tailwind, con acentos técnicos.
*   **Fondo Principal (App Shell):** `#0a0a0a` (Negro profundo).
*   **Fondo de Paneles/Cards (Sidebar, Modales, Tablas):** `#0f0f0f`.
*   **Superficies de Inputs/Botones:** `#050505` a `bg-zinc-900`.
*   **Bordes:** Muy sutiles, predominantemente `border-zinc-800` o `border-zinc-800/60`.
*   **Texto Principal:** `text-zinc-100` y `text-zinc-200` para títulos y datos clave.
*   **Texto Secundario/Labels:** `text-zinc-400` y `text-zinc-500`.
*   **Acentos (Status, Acciones clave):** `emerald-500` (con fondos `emerald-500/10` para badges), `blue-500` (iconos de DB).

### 1.2 Tipografía y Espaciado
*   **Fuente:** Sans-serif por defecto (`font-sans`).
*   **Tamaño base:** `text-[13px]` para maximizar la densidad de datos en pantalla (típico en interfaces de bases de datos).
*   **Datos tabulares y código:** Utilizar `font-mono` para IDs de registros, latencias y tipos de datos.
*   **Scrollbars:** Implementar clase utilitaria `.custom-scrollbar` para barras de desplazamiento minimalistas y oscuras.

## 2. Patrones de Arquitectura de Componentes

El layout debe dividirse utilizando un patrón **App Shell**:
1.  **`App Layout`**: Contenedor principal (`h-screen flex`). No hace scroll.
2.  **`Sidebar`**: Navegación lateral estática a la izquierda. Controla las vistas principales.
3.  **`TopBar`**: Barra superior para breadcrumbs, controles globales y perfil de usuario.
4.  **`Main Content`**: Área dinámica (`flex-1 overflow-auto`) que renderiza la vista activa.
5.  **Modales (`Z-Index: 50`)**: Flotantes sobre todo el contenido con `backdrop-blur-[1px]` y fondo negro con opacidad (`bg-black/60`).

*Nota para el Agente:* En el código de referencia se usa un estado local `currentView` para la navegación. Durante tu implementación, **debes adaptar este enrutamiento local al enrutador real del proyecto** (ej. React Router, TanStack Router, o Next.js App Router según corresponda en el repositorio).

## 3. Código Fuente de Referencia (Implementación Exacta)

Debes integrar, separar en archivos lógicos y hacer funcionales los siguientes componentes. Utiliza la librería `lucide-react` para toda la iconografía.

```jsx
import React, { useState } from 'react';
import { 
  Database, Activity, FileText, CreditCard, Settings, HelpCircle, 
  ChevronDown, ChevronRight, Search, Plus, RefreshCw, LayoutList, 
  Filter, ArrowUpDown, Columns, MoreHorizontal, Copy, Moon, 
  Sidebar as SidebarIcon, Terminal, Table2, Clock, History, Check, X
} from 'lucide-react';

export default function App() {
  const [currentView, setCurrentView] = useState('databases');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isCreateDbModalOpen, setIsCreateDbModalOpen] = useState(false);
  const [isCreateGroupModalOpen, setIsCreateGroupModalOpen] = useState(false);

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-zinc-300 font-sans text-[13px] selection:bg-emerald-500/30 overflow-hidden relative">
      {isSidebarOpen && (
        <Sidebar currentView="{currentView}" onOpenCreateDb="{()" setCurrentView="{setCurrentView}"> setIsCreateDbModalOpen(true)}
          onOpenCreateGroup={() => setIsCreateGroupModalOpen(true)}
        />
      )}
      
      <div className="flex-1 flex flex-col h-full min-w-0">
        <TopBar currentView="{currentView}" isSidebarOpen="{isSidebarOpen}" setCurrentView="{setCurrentView}" setIsSidebarOpen="{setIsSidebarOpen}"/>
        
        <main className="flex-1 overflow-auto relative custom-scrollbar">
          {currentView === 'databases' && <DatabasesView onEdit="{()"> setCurrentView('editor')} />}
          {currentView === 'analytics' && <AnalyticsView/>}
          {currentView === 'settings' && <SettingsView/>}
          {currentView === 'editor' && <DatabaseEditorView/>}
        </main>
      </div>

      {isCreateDbModalOpen && <CreateDatabaseModal onClose="{()"> setIsCreateDbModalOpen(false)} />}
      {isCreateGroupModalOpen && <CreateGroupModal onClose="{()"> setIsCreateGroupModalOpen(false)} />}
    </div>
  );
}

function Sidebar({ currentView, setCurrentView, onOpenCreateDb, onOpenCreateGroup }) {
  const [dbOpen, setDbOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(true);

  const navItems = [
    { id: 'analytics', icon: Activity, label: 'Analytics' },
    { id: 'audit', icon: History, label: 'Audit Logs' },
    { id: 'billing', icon: CreditCard, label: 'Billing' },
  ];

  return (
    <aside className="w-64 flex-shrink-0 border-r border-zinc-800/60 bg-[#0f0f0f] flex flex-col h-full transition-all duration-300">
      <div className="p-4 flex items-center justify-between hover:bg-zinc-800/30 cursor-pointer rounded-lg mx-2 mt-2 transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-zinc-800 flex items-center justify-center">
            <Database className="text-zinc-100" size="{14}"/>
          </div>
          <div>
            <div className="font-semibold text-zinc-100 text-sm">Organización</div>
            <div className="text-xs text-zinc-500">Plan Local</div>
          </div>
        </div>
        <ChevronUpDownIcon/>
      </div>

      <div className="px-4 py-2 flex flex-col gap-2">
        <button onClick={onOpenCreateDb} className="w-full bg-zinc-100 hover:bg-white text-zinc-900 font-medium py-1.5 rounded-md transition-colors">
          Create Database
        </button>
        <button onClick={onOpenCreateGroup} className="w-full bg-transparent hover:bg-zinc-800 border border-zinc-800 text-zinc-300 font-medium py-1.5 rounded-md transition-colors">
          Create Group
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-4 custom-scrollbar flex flex-col gap-0.5">
        <div className="px-3 py-1.5 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">Local Cloud</div>
        
        <div>
          <button 
            onClick={() => setDbOpen(!dbOpen)}
            className={`w-full flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-zinc-800/50 transition-colors ${currentView === 'databases' || currentView === 'editor' ? 'bg-zinc-800/40 text-zinc-100' : ''}`}
          >
            <div className="flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setCurrentView('databases'); }}>
              <Database 'databases' 'editor' 'text-zinc-100' 'text-zinc-400'} : ? className="{currentView" currentView="==" size="{16}" ||/>
              <span>Databases</span>
            </div>
            {dbOpen ? <ChevronDown className="text-zinc-500" size="{14}"/> : <ChevronRight className="text-zinc-500" size="{14}"/>}
          </button>
          
          {dbOpen && (
            <div className="ml-6 mt-1 flex flex-col gap-1">
              <button onClick={() => setCurrentView('databases')} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-zinc-800/60 text-zinc-100 text-sm">
                <span className="w-4 h-3 flex items-center justify-center">
                  <span className="w-2 h-2 rounded-full bg-blue-400/20 border border-blue-400/50 block"></span>
                </span>
                <span>default</span>
                <MoreHorizontal className="ml-auto text-zinc-500" size="{14}"/>
              </button>
            </div>
          )}
        </div>

        {navItems.map(item => (
          <button key={item.id} onClick={() => setCurrentView(item.id)} className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-zinc-800/50 transition-colors ${currentView === item.id ? 'bg-zinc-800/40 text-zinc-100' : 'text-zinc-400'}`}>
            <item.icon size={16} />
            <span>{item.label}</span>
          </button>
        ))}

        <div>
          <button onClick={() => { setSettingsOpen(!settingsOpen); setCurrentView('settings'); }} className={`w-full flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-zinc-800/50 transition-colors ${currentView === 'settings' ? 'bg-zinc-800/40 text-zinc-100' : 'text-zinc-400'}`}>
            <div className="flex items-center gap-2">
              <Settings size="{16}"/>
              <span>Settings</span>
            </div>
            {settingsOpen ? <ChevronDown className="text-zinc-500" size="{14}"/> : <ChevronRight className="text-zinc-500" size="{14}"/>}
          </button>
        </div>
      </nav>

      <div className="p-4 border-t border-zinc-800/60 flex items-center justify-between">
        <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center overflow-hidden">
          <img src="[https://api.dicebear.com/7.x/avataaars/svg?seed=Admin&backgroundColor=27272a](https://api.dicebear.com/7.x/avataaars/svg?seed=Admin&backgroundColor=27272a)" alt="User" className="w-full h-full" />
        </div>
        <button className="text-zinc-500 hover:text-zinc-300 transition-colors"><Moon size="{16}"/></button>
      </div>
    </aside>
  );
}

function TopBar({ isSidebarOpen, setIsSidebarOpen, currentView, setCurrentView }) {
  const getBreadcrumbs = () => {
    switch (currentView) {
      case 'databases': return <span className="text-zinc-100 font-medium">default</span>;
      case 'analytics': return <span className="text-zinc-100 font-medium">Analytics</span>;
      case 'settings': return <span className="text-zinc-100 font-medium">General</span>;
      case 'editor':
        return (
          <>
            <span className="text-zinc-400 cursor-pointer hover:text-zinc-200 transition-colors" onClick={() => setCurrentView('databases')}>mi-db-local</span>
            <ChevronRight className="text-zinc-600 mx-1" size="{14}"/>
            <div className="flex bg-zinc-900/80 rounded-md border border-zinc-800 p-0.5">
              <button className="px-3 py-1 text-xs font-medium text-zinc-400 hover:text-zinc-200 rounded">Overview</button>
              <button className="px-3 py-1 text-xs font-medium text-zinc-100 bg-zinc-800 rounded shadow-sm">Edit Data</button>
            </div>
          </>
        );
      default: return null;
    }
  };

  return (
    <header className="h-14 border-b border-zinc-800/60 flex items-center px-4 shrink-0 bg-[#0a0a0a]/80 backdrop-blur-sm sticky top-0 z-10">
      <div className="flex items-center gap-3">
        <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="text-zinc-400 hover:text-zinc-200"><SidebarIcon size="{18}"/></button>
        <div className="h-4 w-px bg-zinc-800"></div>
        <div className="flex items-center text-sm">
          <span className="text-zinc-400 cursor-pointer hover:text-zinc-200" onClick={() => setCurrentView('databases')}>Databases</span>
          <ChevronRight className="text-zinc-600 mx-2" size="{14}"/>
          {getBreadcrumbs()}
        </div>
      </div>
    </header>
  );
}

function DatabasesView({ onEdit }) {
  const dbs = [
    { name: 'mi-db-local', read: '1,024', written: '256', synced: '0 B', storage: '2.4 MB', group: 'default', status: 'Active' },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto w-full">
      <div className="overflow-x-auto border border-zinc-800/80 rounded-lg bg-[#0f0f0f]">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-zinc-800/80 text-zinc-400 text-xs font-medium">
              <th className="py-3 px-4 font-normal">Name</th>
              <th className="py-3 px-4 font-normal">Rows Read</th>
              <th className="py-3 px-4 font-normal">Rows Written</th>
              <th className="py-3 px-4 font-normal">Storage</th>
              <th className="py-3 px-4 font-normal">Status</th>
              <th className="py-3 px-4 font-normal w-24"></th>
            </tr>
          </thead>
          <tbody>
            {dbs.map((db, i) => (
              <tr key={i} className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors group">
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2">
                    <Database className="text-blue-500" size="{14}"/>
                    <span className="font-medium text-zinc-200">{db.name}</span>
                  </div>
                </td>
                <td className="py-3 px-4">{db.read}</td>
                <td className="py-3 px-4">{db.written}</td>
                <td className="py-3 px-4">{db.storage}</td>
                <td className="py-3 px-4">
                  <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-xs font-medium">{db.status}</span>
                </td>
                <td className="py-3 px-4 flex justify-end gap-2 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={onEdit} className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-1.5 rounded text-xs font-medium border border-zinc-700 transition-colors">
                    <Table2 size="{14}"/> Edit Data
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AnalyticsView() { return <div className="p-6 max-w-7xl mx-auto"><h2 className="text-xl text-zinc-100">Analytics</h2></div>; }
function SettingsView() { return <div className="p-6 max-w-4xl mx-auto"><h2 className="text-xl text-zinc-100">Settings</h2></div>; }

function DatabaseEditorView() {
  const tables = ['usuarios', 'configuracion'];
  return (
    <div className="flex h-full w-full absolute inset-0">
      <div className="w-64 border-r border-zinc-800/60 bg-[#0a0a0a] flex flex-col h-full shrink-0">
        <div className="p-3 border-b border-zinc-800/60">
          <button className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-zinc-700 bg-zinc-800/40 hover:bg-zinc-800 transition-colors text-zinc-300">
            <Terminal size="{16}"/> SQL console
          </button>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
          {tables.map(table => (
            <button key={table} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300">
              <Table2 className="shrink-0" size="{14}"/><span className="truncate text-xs">{table}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 bg-[#0a0a0a] p-6 text-zinc-500 flex items-center justify-center">Select a table to view data</div>
    </div>
  );
}

function CreateDatabaseModal({ onClose }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-[1px]">
      <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl w-full max-w-[480px] p-6 shadow-2xl">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">Create Database</h2>
            <p className="text-sm text-zinc-400 mt-1">Create a new local SQLite database</p>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-md"><X size="{20}"/></button>
        </div>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="w-14 text-sm font-medium text-zinc-300">Name</label>
            <input type="text" placeholder="Name" className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" />
          </div>
        </div>
        <div className="mt-8 flex justify-end">
          <button className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm">Create Database</button>
        </div>
      </div>
    </div>
  );
}

function CreateGroupModal({ onClose }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-[1px]">
      <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl w-full max-w-[480px] p-6 shadow-2xl">
        <div className="flex justify-between items-start mb-6">
          <div><h2 className="text-xl font-semibold text-zinc-100">New Group</h2></div>
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-md"><X size="{20}"/></button>
        </div>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="w-16 text-sm font-medium text-zinc-300">Name</label>
            <input type="text" placeholder="Name" className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" />
          </div>
        </div>
        <div className="mt-8 flex justify-end">
          <button className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm">Create Group</button>
        </div>
      </div>
    </div>
  );
}

function ChevronUpDownIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>;
}
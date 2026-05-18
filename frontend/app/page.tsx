"use client";

import Link from 'next/link';
import {
  ArrowRight,
  Database,
  Layers3,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Workflow,
} from 'lucide-react';

export default function HomePage() {
  return (
    <div className="min-h-screen overflow-hidden bg-[#050608] text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_28%),radial-gradient(circle_at_top_right,rgba(34,211,238,0.14),transparent_24%),linear-gradient(180deg,#09111a_0%,#050608_55%,#030304_100%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:72px_72px]" />

      <main className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between gap-4 border-b border-white/8 pb-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-emerald-400/20 bg-emerald-400/10 shadow-[0_0_40px_rgba(16,185,129,0.16)]">
              <Database className="h-5 w-5 text-emerald-300" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-[0.24em] text-zinc-400 uppercase">libsqlite</div>
              <div className="text-sm text-zinc-500">Control plane autoalojado para SQLite y libSQL</div>
            </div>
          </div>

          <Link
            href="/login"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-white"
          >
            Iniciar sesión
            <ArrowRight className="h-4 w-4" />
          </Link>
        </header>

        <section className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-[1.15fr_0.85fr] lg:py-16">
          <div className="max-w-3xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/8 px-4 py-2 text-sm text-emerald-200 shadow-[0_0_36px_rgba(16,185,129,0.10)]">
              <Sparkles className="h-4 w-4" />
              Panel moderno para administrar SQLite, libSQL y bases importadas
            </div>

            <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              Un panel serio, claro y seguro para tus bases de datos autoalojadas.
            </h1>

            <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-300 sm:text-lg">
              Gestiona archivos SQLite locales, importa bases existentes, descubre volúmenes montados y opera
              endpoints libSQL desde una sola interfaz con control de acceso, auditoría y despliegue flexible.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-100"
              >
                Iniciar sesión
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/5 px-6 py-3 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
              >
                Abrir el panel de administración
              </Link>
            </div>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 backdrop-blur-sm">
                <ShieldCheck className="h-5 w-5 text-emerald-300" />
                <p className="mt-3 text-sm font-medium text-zinc-100">RBAC y auditoría</p>
                <p className="mt-1 text-sm leading-6 text-zinc-400">Control de permisos, sesiones y trazabilidad.</p>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 backdrop-blur-sm">
                <Layers3 className="h-5 w-5 text-cyan-300" />
                <p className="mt-3 text-sm font-medium text-zinc-100">Control + datos</p>
                <p className="mt-1 text-sm leading-6 text-zinc-400">Separa metadatos, secretos y archivos reales.</p>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 backdrop-blur-sm">
                <Workflow className="h-5 w-5 text-amber-300" />
                <p className="mt-3 text-sm font-medium text-zinc-100">Flujo operativo</p>
                <p className="mt-1 text-sm leading-6 text-zinc-400">Provisiona, consulta, migra e importa desde un solo lugar.</p>
              </div>
            </div>
          </div>

          <div className="relative lg:pl-8">
            <div className="absolute -inset-8 rounded-[2rem] bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.18),transparent_35%)] blur-2xl" />
            <div className="relative rounded-[2rem] border border-white/10 bg-[#071019]/85 p-5 shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-white/8 pb-4">
                <div>
                  <div className="text-xs font-medium uppercase tracking-[0.24em] text-zinc-500">Estado de la plataforma</div>
                  <div className="mt-1 text-lg font-semibold text-white">Operando en tu infraestructura</div>
                </div>
                <div className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-200">
                  Activo
                </div>
              </div>

              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/12 text-emerald-300">
                      <Database className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">SQLite local</p>
                      <p className="text-sm text-zinc-400">Importación, adopción y almacenamiento estructurado.</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-400/12 text-cyan-300">
                      <TerminalSquare className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">Studio integrado</p>
                      <p className="text-sm text-zinc-400">Consulta SQL, explora esquemas y valida conexiones.</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/12 text-amber-300">
                      <ShieldCheck className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">Seguridad y sesiones</p>
                      <p className="text-sm text-zinc-400">Cookies HttpOnly, CSRF y auditoría de acciones.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 border-t border-white/8 py-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Panel</p>
            <p className="mt-3 text-sm leading-6 text-zinc-300">Una experiencia visual sobria, con contraste alto y foco en tareas operativas.</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Color</p>
            <p className="mt-3 text-sm leading-6 text-zinc-300">Base oscura neutra con acentos verde-emerald y cian para evitar ruido visual.</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Acción</p>
            <p className="mt-3 text-sm leading-6 text-zinc-300">El acceso principal está en un solo CTA: Iniciar sesión.</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Uso</p>
            <p className="mt-3 text-sm leading-6 text-zinc-300">Pensado para servidor propio, VPS y despliegues en Docker o Coolify.</p>
          </div>
        </section>
      </main>
    </div>
  );
}

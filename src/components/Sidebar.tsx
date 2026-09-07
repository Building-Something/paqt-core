import { Link, NavLink, useNavigate } from 'react-router-dom';
import {
  FilePenLine,
  FilePlus2,
  Info,
  LayoutDashboard,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react';
import { useAnalysis } from '../contexts/AnalysisContext';
import { useServerHealth } from '../hooks/useServerHealth';

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label="Paqt home">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#4f46e5" />
        <path d="M11 8v16" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
        <path d="M21 8v16" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
        <path d="M11 16h10" stroke="#eef2ff" strokeWidth="3.2" strokeLinecap="round" />
      </svg>
      <span className="text-lg font-bold tracking-tight text-ink-900">Paqt</span>
    </Link>
  );
}

function HealthBadge() {
  const health = useServerHealth();

  const meta =
    health.status === 'ok'
      ? { dot: 'bg-low-500', label: 'AI connected' }
      : health.status === 'missing'
        ? { dot: 'bg-medium-500', label: 'AI key not set' }
        : health.status === 'offline'
          ? { dot: 'bg-critical-500', label: 'Server offline' }
          : { dot: 'bg-ink-300', label: 'Checking' };

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-ink-500"
      title={meta.label}
    >
      <span className="relative flex size-2" aria-hidden="true">
        <span className={`absolute inline-flex size-full rounded-full ${meta.dot} opacity-60`} />
        <span className={`relative inline-flex size-2 rounded-full ${meta.dot}`} />
      </span>
      {meta.label}
    </span>
  );
}

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return [
    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-primary-50 text-primary-800'
      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
  ].join(' ');
}

const WORKSPACE_LINKS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/analyze', label: 'Analyze', icon: ScanSearch, end: false },
  { to: '/generate', label: 'Compose', icon: FilePenLine, end: false },
] as const;

const INFO_LINKS = [
  { to: '/about', label: 'About', icon: Info, end: false },
  { to: '/privacy', label: 'Privacy', icon: ShieldCheck, end: false },
] as const;

export function Sidebar() {
  const navigate = useNavigate();
  const { reset } = useAnalysis();

  function handleNewAnalysis() {
    reset();
    navigate('/analyze');
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-[100dvh] w-60 shrink-0 flex-col border-r border-ink-200 bg-white lg:flex">
        <div className="flex h-14 items-center border-b border-ink-100 px-5">
          <Logo />
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Workspace
          </p>
          <nav className="mt-2 flex flex-col gap-1" aria-label="Workspace">
            {WORKSPACE_LINKS.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end} className={navLinkClass}>
                <link.icon className="size-4" aria-hidden="true" />
                {link.label}
              </NavLink>
            ))}
          </nav>

          <p className="mt-6 px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Info
          </p>
          <nav className="mt-2 flex flex-col gap-1" aria-label="Info">
            {INFO_LINKS.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end} className={navLinkClass}>
                <link.icon className="size-4" aria-hidden="true" />
                {link.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="border-t border-ink-100 px-3 py-4">
          <button type="button" onClick={handleNewAnalysis} className="btn-primary w-full">
            <FilePlus2 className="size-4" aria-hidden="true" />
            New analysis
          </button>
          <div className="mt-3 flex items-center justify-between px-1">
            <HealthBadge />
            <span className="text-[11px] text-ink-400">v1</span>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 border-b border-ink-200 bg-white/90 backdrop-blur lg:hidden">
        <div className="mx-auto flex h-14 max-w-screen-xl items-center justify-between gap-3 px-4">
          <Logo />
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-1 inline-flex" aria-hidden="true">
              <HealthBadge />
            </span>
            <Link to="/" className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900">
              Home
            </Link>
            <Link to="/analyze" className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900">
              Analyze
            </Link>
            <Link to="/generate" className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900">
              Compose
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}
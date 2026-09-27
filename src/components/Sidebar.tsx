import { Link, NavLink, useNavigate } from 'react-router-dom';
import {
  CreditCard,
  FilePenLine,
  FilePlus2,
  Home,
  LayoutDashboard,
  LogOut,
  ScanSearch,
  Settings2,
} from 'lucide-react';
import { useAnalysis } from '../contexts/AnalysisContext';
import { useAuth } from '../contexts/AuthContext';
import { usePlan } from '../contexts/PlanContext';
import { useToast } from '../contexts/ToastContext';
import { useServerHealth } from '../hooks/useServerHealth';
import { Button } from './ui/button';
import { ThemeToggle } from './ThemeToggle';

function Logo() {
  return (
    <Link to="/dashboard" className="flex items-center gap-2.5" aria-label="Paqt dashboard">
      <img src="/assets/Logo-Variant-Transparent.png" alt="Paqt logo" className="size-7 object-contain" />
      <span className="text-lg font-semibold tracking-tight text-foreground">Paqt</span>
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
          : { dot: 'bg-muted-foreground/40', label: 'Checking' };

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={meta.label}>
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
    'flex h-9 items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors',
    isActive
      ? 'bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  ].join(' ');
}

const NAV_SECTIONS = [
  {
    label: 'Overview',
    links: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    label: 'Workspace',
    links: [
      { to: '/analyze', label: 'Review documents', icon: ScanSearch, end: false },
      { to: '/generate', label: 'Draft agreements', icon: FilePenLine, end: false },
    ],
  },
  {
    label: 'Resources',
    links: [
      { to: '/', label: 'Site home', icon: Home, end: true },
      { to: '/pricing', label: 'Pricing', icon: CreditCard, end: false },
      { to: '/settings', label: 'Settings', icon: Settings2, end: false },
    ],
  },
] as const;

function UserCard() {
  const { user, signOut } = useAuth();
  const { reset } = useAnalysis();
  const navigate = useNavigate();
  const { toast } = useToast();

  const initial = (user?.email ?? '?').charAt(0).toUpperCase();

  async function handleSignOut() {
    await signOut();
    reset();
    navigate('/');
    toast('info', 'Signed out. Your reviews stay safe in your account.');
  }

  return (
    <>
      <Button className="w-full" onClick={() => {
        reset();
        navigate('/analyze');
      }}>
        <FilePlus2 className="size-4" aria-hidden="true" />
        New review
      </Button>
      <div className="mt-3 flex items-center gap-2.5 rounded-lg px-2 py-1.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {user?.email ?? 'Guest workspace'}
          </p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <HealthBadge />
            <span className="text-[11px] text-muted-foreground/50">v1</span>
          </div>
        </div>
        {user ? (
          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign out"
            title="Sign out"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOut className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </>
  );
}

export function Sidebar() {
  const { user } = useAuth();
  const { hasAccess, loading } = usePlan();

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-[100dvh] w-64 shrink-0 flex-col border-r border-border bg-background lg:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-border px-5">
          <Logo />
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="mb-6">
              <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {section.label}
              </p>
              <nav className="mt-1.5 flex flex-col gap-1" aria-label={section.label}>
                {section.links.map((link) => (
                  <NavLink key={link.to} to={link.to} end={link.end} className={navLinkClass}>
                    <link.icon className="size-4" aria-hidden="true" />
                    {link.label}
                  </NavLink>
                ))}
              </nav>
            </div>
          ))}

          {!loading && !hasAccess ? (
            <Link
              to="/pricing"
              className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
            >
              <span>Get a plan to analyze</span>
              <CreditCard className="size-4" aria-hidden="true" />
            </Link>
          ) : null}
        </div>

        <div className="border-t border-border p-3">
          <UserCard />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur lg:hidden">
        <div className="mx-auto flex h-14 max-w-screen-xl items-center justify-between gap-3 px-4">
          <Logo />
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-1 inline-flex" aria-hidden="true">
              <HealthBadge />
            </span>
            <Link
              to="/dashboard"
              className="rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Dashboard
            </Link>
            <Link
              to="/analyze"
              className="rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Review
            </Link>
            <Link
              to="/generate"
              className="rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Draft
            </Link>
            <Link
              to="/pricing"
              className="rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Plans
            </Link>
            <span className="ml-1">
              <ThemeToggle />
            </span>
            {user ? (
              <span className="ml-0.5" title={`Signed in as ${user.email ?? 'you'}`}>
                <span
                  aria-hidden="true"
                  className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
                >
                  {user.email?.charAt(0).toUpperCase()}
                </span>
              </span>
            ) : null}
          </div>
        </div>
      </header>
    </>
  );
}
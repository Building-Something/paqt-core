import { Link, useLocation, useNavigate, Outlet } from 'react-router-dom';
import { ChevronRight, FilePlus2, LogOut, Sparkles } from 'lucide-react';
import { useAnalysis } from '../contexts/AnalysisContext';
import { useAuth } from '../contexts/AuthContext';
import { useEntitlement } from '../contexts/EntitlementContext';
import { useToast } from '../contexts/ToastContext';
import { isPlanActive, isPlanCanceling } from '../services/entitlementService';
import { Button } from './ui/button';
import { ThemeToggle } from './ThemeToggle';
import { Sidebar } from './Sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const TITLE_BY_PATH: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/analyze': 'Review documents',
  '/generate': 'Draft agreements',
  '/analysis': 'Workspace',
  '/about': 'About',
  '/privacy': 'Privacy',
};

function UserMenu() {
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
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary ring-offset-background transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {initial}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="truncate">
          {user?.email ?? 'Account'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => {
            void handleSignOut();
          }}
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavPlanBadge() {
  const { usage, loading } = useEntitlement();

  if (loading || !usage.signedIn) {
    return null;
  }

  if (!isPlanActive(usage)) {
    return (
      <Link
        to="/pricing"
        title="Choose a plan"
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-primary/40 bg-primary/5 px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
      >
        <Sparkles className="size-3.5" aria-hidden="true" />
        Choose plan
      </Link>
    );
  }

  const canceling = isPlanCanceling(usage);
  const date = new Date(usage.periodEnd ?? Date.now()).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  const tone = canceling
    ? 'border-medium-500/30 bg-medium-500/10 text-medium-700 dark:border-medium-500/25 dark:text-medium-500'
    : 'border-low-500/30 bg-low-500/10 text-low-700 dark:border-low-500/25 dark:text-low-500';
  const dot = canceling ? 'bg-medium-500' : 'bg-low-500';

  return (
    <Link
      to="/pricing"
      title={
        canceling
          ? `${usage.planName ?? 'Plan'} active until ${date}`
          : `${usage.planName ?? 'Plan'} · resets ${date}`
      }
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm backdrop-blur transition-colors hover:brightness-110 ${tone}`}
    >
      <Sparkles className="size-3.5" aria-hidden="true" />
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
      <span className="font-semibold">{usage.planName ?? 'Plan'}</span>
      <span className="opacity-60" aria-hidden="true">
        ·
      </span>
      <span className="tabular-nums opacity-90">{canceling ? `until ${date}` : `resets ${date}`}</span>
    </Link>
  );
}

function TopBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { reset } = useAnalysis();

  const title = TITLE_BY_PATH[location.pathname] ?? 'Paqt';

  function handleNewAnalysis() {
    reset();
    navigate('/analyze');
  }

  return (
    <header className="sticky top-0 z-30 hidden h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-6 backdrop-blur lg:flex">
      <div className="flex items-center gap-2 text-sm">
        <Link
          to="/"
          className="text-muted-foreground transition-colors hover:text-foreground"
          title="Back to the Paqt site"
        >
          Paqt
        </Link>
        <ChevronRight className="size-3.5 text-muted-foreground/40" aria-hidden="true" />
        <span className="font-medium text-foreground">{title}</span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <NavPlanBadge />
        <ThemeToggle />
        <Button size="sm" onClick={handleNewAnalysis}>
          <FilePlus2 className="size-4" aria-hidden="true" />
          New review
        </Button>
        <UserMenu />
      </div>
    </header>
  );
}

export function AppShell() {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-muted/40 lg:flex-row">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
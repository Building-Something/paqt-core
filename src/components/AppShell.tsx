import { Link, useLocation, useNavigate, Outlet } from 'react-router-dom';
import { ChevronRight, FilePlus2, LogOut } from 'lucide-react';
import { useAnalysis } from '../contexts/AnalysisContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
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
import { Link } from 'react-router-dom';
import { Button } from './ui/button';
import { ThemeToggle } from './ThemeToggle';
import { useAuth } from '../contexts/AuthContext';

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label="Paqt home">
      <img
        src="/assets/Logo-Variant-Transparent.png"
        alt="Paqt logo"
        className="size-7 object-contain"
      />
      <span className="font-display text-lg font-semibold tracking-tight text-foreground">Paqt</span>
    </Link>
  );
}

export function MarketingNav() {
  const { session } = useAuth();
  const signedIn = Boolean(session);

  return (
    <header className="sticky top-3 z-50 -mb-14 pointer-events-none">
    <div className="pointer-events-auto mx-auto flex w-fit max-w-full items-center justify-center px-3 sm:px-4">
      <div className="relative flex h-14 w-fit max-w-full items-center justify-center gap-2 overflow-x-auto rounded-2xl border border-border/60 bg-background/40 px-2 shadow-[0_8px_30px_-12px_hsl(var(--primary)/0.4)] backdrop-blur-2xl backdrop-saturate-200 no-scrollbar supports-[backdrop-filter]:bg-background/30 sm:gap-3 sm:px-3">
        <div
          className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent dark:via-primary/50"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-x-4 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <Logo />
        </div>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          <a
            href="#features"
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Features
          </a>
          <a
            href="#how"
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            How it works
          </a>
          <a
            href="#faq"
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            FAQ
          </a>
          <Link
            to="/about"
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            About
          </Link>
          <Link
            to="/pricing"
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Pricing
          </Link>
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          {signedIn ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/dashboard">Dashboard</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link to="/signin">Sign in</Link>
            </Button>
          )}
          <Button size="sm" asChild>
            <Link to={signedIn ? '/analyze' : '/signup'}>
              {signedIn ? 'Open workspace' : 'Get started'}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
        <Logo />
        <nav
          className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground"
          aria-label="Footer"
        >
          <Link to="/dashboard" className="transition-colors hover:text-foreground">
            Dashboard
          </Link>
          <Link to="/features" className="transition-colors hover:text-foreground">
            Features
          </Link>
          <Link to="/pricing" className="transition-colors hover:text-foreground">
            Pricing
          </Link>
          <Link to="/about" className="transition-colors hover:text-foreground">
            About
          </Link>
          <Link to="/privacy" className="transition-colors hover:text-foreground">
            Privacy
          </Link>
        </nav>
        <p className="text-xs text-muted-foreground/70">
          Decision support, not legal advice.
        </p>
      </div>
    </footer>
  );
}
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
      <span className="text-lg font-semibold tracking-tight text-foreground">Paqt</span>
    </Link>
  );
}

export function MarketingNav() {
  const { session } = useAuth();
  const signedIn = Boolean(session);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Logo />
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
        </nav>
        <div className="flex items-center gap-2">
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
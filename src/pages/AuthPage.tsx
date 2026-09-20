import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Spinner, SuccessCheck } from '../components/ui/feedback';
import { Button } from '../components/ui/button';
import { MarketingFooter } from '../components/MarketingNav';

type Mode = 'signin' | 'signup';
type FormStatus = 'idle' | 'submitting' | 'success' | 'pending';

interface AuthPageProps {
  mode: Mode;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function AuthPage({ mode }: AuthPageProps) {
  const { session, initializing, configured, signIn, signUp } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formStatus, setFormStatus] = useState<FormStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ email?: string; password?: string }>({});

  const isSignup = mode === 'signup';

  useEffect(() => {
    if (session && !initializing && formStatus !== 'pending') {
      navigate(from, { replace: true });
    }
  }, [session, initializing, from, formStatus, navigate]);

  function validate(): boolean {
    const next: { email?: string; password?: string } = {};
    if (!isValidEmail(email)) {
      next.email = 'Enter a valid email address.';
    }
    if (password.length < 6) {
      next.password = 'Password must be at least 6 characters.';
    }
    setFieldError(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (formStatus === 'submitting' || formStatus === 'success') {
      return;
    }
    if (!validate()) {
      return;
    }
    setFormStatus('submitting');
    setError(null);

    let result;
    try {
      result = isSignup
        ? await signUp(email.trim(), password)
        : await signIn(email.trim(), password);
    } catch (caught) {
      result = {
        ok: false,
        pendingConfirmation: false,
        error: caught instanceof Error ? caught.message : 'Something went wrong. Try again.',
      };
    }

    if (!result.ok) {
      setError(result.error ?? 'Something went wrong. Try again.');
      setFormStatus('idle');
      return;
    }

    if (result.pendingConfirmation) {
      setFormStatus('pending');
      return;
    }

    setFormStatus('success');
    toast('success', isSignup ? 'Account created — welcome to Paqt.' : 'Signed in — welcome back.');
    window.setTimeout(() => {
      navigate(from, { replace: true });
    }, 900);
  }

  if (initializing) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <Spinner className="size-5 text-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <div className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_60%_at_50%_-10%,hsl(var(--primary)/0.09),transparent)]"
          aria-hidden="true"
        />
        <div className="relative mx-auto flex w-full max-w-md flex-col px-4 pt-16 sm:pt-24">
          <Link to="/" className="flex items-center justify-center gap-2.5" aria-label="Paqt home">
            <img
              src="/assets/Logo-Variant-Transparent.png"
              alt="Paqt logo"
              className="size-8 object-contain"
            />
            <span className="text-xl font-semibold tracking-tight text-foreground">Paqt</span>
          </Link>

          <div className="animate-fade-in-up mt-8">
            {!configured ? (
              <div className="card p-6 text-center">
                <h1 className="text-lg font-semibold text-foreground">Supabase not configured</h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Add <code className="rounded bg-muted px-1.5 py-0.5 text-xs">VITE_SUPABASE_URL</code>{' '}
                  and{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    VITE_SUPABASE_PUBLISHABLE_KEY
                  </code>{' '}
                  to <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.env</code>, then restart
                  the dev server.
                </p>
              </div>
            ) : formStatus === 'pending' ? (
              <div className="card animate-scale-in p-8 text-center">
                <div className="mx-auto size-11 text-primary">
                  <SuccessCheck className="size-11" />
                </div>
                <h1 className="mt-5 text-lg font-semibold text-foreground">Check your inbox</h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  We sent a confirmation link to <span className="font-medium text-foreground">{email}</span>.
                  Confirm your email and you can sign right in.
                </p>
                <Button asChild variant="outline" className="mt-6">
                  <Link to="/signin">Back to sign in</Link>
                </Button>
              </div>
            ) : (
              <div className="card animate-fade-in-up p-6 sm:p-8">
                {formStatus === 'success' ? (
                  <div className="flex flex-col items-center py-8 text-center">
                    <div className="size-12 text-low-600 dark:text-low-500">
                      <SuccessCheck className="animate-pop-success size-12" />
                    </div>
                    <p className="mt-4 text-base font-semibold text-foreground">
                      {isSignup ? 'Account created' : 'You’re signed in'}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">Taking you to your workspace…</p>
                  </div>
                ) : (
                  <>
                    <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                      {isSignup ? 'Create your account' : 'Welcome back'}
                    </h1>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {isSignup
                        ? 'Your contract reviews sync to your account across devices.'
                        : 'Sign in to open your contract reviews and drafts.'}
                    </p>

                    <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
                      <div>
                        <label className="label" htmlFor="auth-email">
                          Email
                        </label>
                        <input
                          id="auth-email"
                          type="email"
                          autoComplete="email"
                          className="input"
                          value={email}
                          onChange={(event) => {
                            setEmail(event.target.value);
                            setFieldError((prev) => ({ ...prev, email: undefined }));
                          }}
                          placeholder="you@company.com"
                          aria-invalid={Boolean(fieldError.email)}
                        />
                        {fieldError.email ? (
                          <p className="animate-fade-in mt-1.5 text-xs text-destructive">
                            {fieldError.email}
                          </p>
                        ) : null}
                      </div>

                      <div>
                        <label className="label" htmlFor="auth-password">
                          Password
                        </label>
                        <input
                          id="auth-password"
                          type="password"
                          autoComplete={isSignup ? 'new-password' : 'current-password'}
                          className="input"
                          value={password}
                          onChange={(event) => {
                            setPassword(event.target.value);
                            setFieldError((prev) => ({ ...prev, password: undefined }));
                          }}
                          placeholder="At least 6 characters"
                          aria-invalid={Boolean(fieldError.password)}
                        />
                        {fieldError.password ? (
                          <p className="animate-fade-in mt-1.5 text-xs text-destructive">
                            {fieldError.password}
                          </p>
                        ) : null}
                      </div>

                      {error ? (
                        <div className="animate-slide-down flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                          <span>{error}</span>
                        </div>
                      ) : null}

                      <Button type="submit" size="lg" disabled={formStatus === 'submitting'}>
                        {formStatus === 'submitting' ? (
                          <>
                            <Spinner className="size-4" />
                            {isSignup ? 'Creating account…' : 'Signing in…'}
                          </>
                        ) : (
                          <>
                            {isSignup ? 'Create account' : 'Sign in'}
                            <ArrowRight className="size-4" aria-hidden="true" />
                          </>
                        )}
                      </Button>
                    </form>

                    <p className="mt-5 text-center text-sm text-muted-foreground">
                      {isSignup ? (
                        <>
                          Already have an account?{' '}
                          <Link
                            to="/signin"
                            className="font-medium text-primary hover:underline"
                          >
                            Sign in
                          </Link>
                        </>
                      ) : (
                        <>
                          New to Paqt?{' '}
                          <Link
                            to="/signup"
                            className="font-medium text-primary hover:underline"
                          >
                            Create a free account
                          </Link>
                        </>
                      )}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <MarketingFooter />
    </div>
  );
}
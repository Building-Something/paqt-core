import { useState, type FormEvent } from 'react';
import { KeyRound, TriangleAlert, ShieldCheck, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useAnalysis } from '../contexts/AnalysisContext';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { BillingSettings } from '../components/BillingSettings';

export function SettingsPage() {
  const { user, changePassword, deleteAccount } = useAuth();
  const { reset } = useAnalysis();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmNext, setConfirmNext] = useState('');
  const [busyPassword, setBusyPassword] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  async function handlePasswordSubmit(event: FormEvent) {
    event.preventDefault();
    if (next.length < 6) {
      toast('error', 'New password must be at least 6 characters.');
      return;
    }
    if (next !== confirmNext) {
      toast('error', 'New passwords don’t match.');
      return;
    }
    setBusyPassword(true);
    const result = await changePassword(current, next);
    setBusyPassword(false);
    if (result.ok) {
      toast('success', 'Password changed. Use it next time you sign in.');
      setCurrent('');
      setNext('');
      setConfirmNext('');
    } else {
      toast('error', result.error ?? 'Could not change password.');
    }
  }

  async function handleDeleteAccount() {
    if (confirmText.trim().toLowerCase() !== 'delete forever') {
      toast('error', 'Type “delete forever” to confirm.');
      return;
    }
    setDeleting(true);
    const result = await deleteAccount();
    if (result.ok) {
      toast('info', 'Account deleted. All saved history is gone forever.');
      reset();
      navigate('/');
    } else {
      setDeleting(false);
      toast('error', result.error ?? 'Something went wrong deleting the account.');
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 lg:py-8">
      <p className="text-sm font-medium text-muted-foreground">Your account</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Signed in as <span className="font-medium text-foreground">{user?.email}</span>. Your
        reviews are saved to your Supabase account — nothing is stored only on this device.
      </p>

      <BillingSettings />

      <section className="mt-6 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <KeyRound className="size-4 text-primary" aria-hidden="true" />
            Change password
          </h2>
        </div>
        <form onSubmit={handlePasswordSubmit} className="space-y-4 px-5 py-5">
          <div className="grid gap-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              minLength={6}
              value={next}
              onChange={(event) => setNext(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={6}
              value={confirmNext}
              onChange={(event) => setConfirmNext(event.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={busyPassword} className="w-full sm:w-auto">
            {busyPassword ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busyPassword ? 'Changing…' : 'Update password'}
          </Button>
        </form>
      </section>

      <section className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5">
        <div className="border-b border-destructive/20 px-5 py-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <TriangleAlert className="size-4" aria-hidden="true" />
            Delete account permanently
          </h2>
        </div>
        <div className="space-y-4 px-5 py-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            This permanently deletes <span className="font-semibold text-foreground">your account
            and all of your saved history forever</span> — every review, every saved PDF, and every
            AI finding. This cannot be undone and cannot be recovered.
          </p>
          <div className="grid gap-2">
            <Label htmlFor="delete-confirm">Type “delete forever” to confirm</Label>
            <Input
              id="delete-confirm"
              type="text"
              autoComplete="off"
              placeholder="delete forever"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              required
            />
          </div>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting || confirmText.trim().toLowerCase() !== 'delete forever'}
            onClick={() => void handleDeleteAccount()}
          >
            {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {deleting ? 'Deleting…' : 'Delete my account forever'}
          </Button>
        </div>
      </section>

      <p className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
        Your contract or PDF is safe — reviews live in your private Supabase account.
      </p>
    </div>
  );
}

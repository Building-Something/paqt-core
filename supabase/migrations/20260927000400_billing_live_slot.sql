-- Free the one-live slot when Razorpay has already ended the subscription.
--
-- subscriptions_one_live_per_user exists to stop two *billable* subscriptions for
-- one account: Razorpay has no idempotency key on POST /v1/subscriptions, so two
-- concurrent checkouts would both charge. The predicate listed Paqt's own status
-- only, which made a row hold the slot even after the provider had ended it.
--
-- That is reachable in normal use. When Razorpay refuses to schedule a cycle-end
-- cancellation (it does for UPI payment mode), Paqt cancels at the provider to
-- stop the renewal and keeps the paid period itself, so the row stays 'canceling'
-- with razorpay_status = 'cancelled'. That row can never charge again, but it
-- still occupied the live slot, and the customer was told to "cancel it from Plan &
-- billing" — advice they could not follow, because it was already cancelled. They
-- could neither buy a new plan nor renew for the rest of the period.
--
-- The guard now counts a row only while the provider can still take money for it.
-- 'halted' and 'paused' stay in the set: both can be resumed and would then bill.
-- A row with no recorded provider status stays in the set too, because "unknown"
-- must not be treated as "safe to duplicate".
--
-- Entitlement is unaffected: subscriptions_entitlement_lookup deliberately still
-- includes 'canceling', so the paid period keeps granting access.

drop index if exists public.subscriptions_one_live_per_user;

create unique index if not exists subscriptions_one_live_per_user
  on public.subscriptions (user_id)
  where status in ('authenticating', 'active', 'canceling', 'past_due', 'paused')
    and (
      razorpay_status is null
      or razorpay_status not in ('cancelled', 'canceled', 'completed', 'expired')
    );

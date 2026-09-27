export const RAZORPAY_CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

type RazorpayInstance = {
  open(): void;
  close(): void;
  on(event: string, handler: (response: unknown) => void): void;
};

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

type WindowWithRazorpay = Window & { Razorpay?: RazorpayConstructor };

let scriptPromise: Promise<void> | null = null;
let testCtor: RazorpayConstructor | null = null;

export function setRazorpayCtorForTest(ctor: RazorpayConstructor | null): void {
  testCtor = ctor;
}

export function loadRazorpayScript(): Promise<void> {
  if (testCtor) {
    return Promise.resolve();
  }
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${RAZORPAY_CHECKOUT_SCRIPT_URL}"]`,
      );
      if (existing) {
        if ((window as WindowWithRazorpay).Razorpay) {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Could not load Razorpay checkout.')));
        return;
      }
      const script = document.createElement('script');
      script.src = RAZORPAY_CHECKOUT_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error('Could not load Razorpay checkout.'));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

export interface SubscriptionCheckoutOptions {
  key: string;
  subscriptionId: string;
  name: string;
  description: string;
  prefillName?: string;
  prefillEmail?: string;
}

export type SubscriptionCheckoutOutcome = 'paid' | 'dismissed';

export async function openSubscriptionCheckout(
  options: SubscriptionCheckoutOptions,
): Promise<SubscriptionCheckoutOutcome> {
  await loadRazorpayScript();
  const Ctor = testCtor ?? (window as WindowWithRazorpay).Razorpay;
  if (!Ctor) {
    throw new Error('Razorpay checkout is unavailable. Please try again in a moment.');
  }
  return new Promise<SubscriptionCheckoutOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: SubscriptionCheckoutOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };
    const checkout = new Ctor({
      key: options.key,
      subscription_id: options.subscriptionId,
      name: options.name,
      description: options.description,
      prefill: {
        name: options.prefillName,
        email: options.prefillEmail,
      },
      theme: { color: '#6d5afe' },
      handler: () => settle('paid'),
      modal: {
        ondismiss: () => settle('dismissed'),
      },
    });
    checkout.on('payment.failed', () => settle('dismissed'));
    checkout.open();
  });
}
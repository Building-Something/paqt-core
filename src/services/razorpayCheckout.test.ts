import { afterEach, describe, expect, it } from 'vitest';
import { openSubscriptionCheckout, setRazorpayCtorForTest } from './razorpayCheckout';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeCtor(): {
  Ctor: new (options: Record<string, unknown>) => {
    open(): void;
    on(event: string, handler: (response: unknown) => void): void;
    close(): void;
  };
  lastOptions: () => Record<string, unknown>;
} {
  let options: Record<string, unknown> = {};
  const Ctor = class {
    constructor(opts: Record<string, unknown>) {
      options = opts;
    }
    open() {}
    on() {}
    close() {}
  };
  return { Ctor, lastOptions: () => options };
}

describe('openSubscriptionCheckout', () => {
  afterEach(() => {
    setRazorpayCtorForTest(null);
  });

  it('passes the key and subscription id to the SDK', async () => {
    const { Ctor, lastOptions } = fakeCtor();
    setRazorpayCtorForTest(Ctor as never);
    const promise = openSubscriptionCheckout({
      key: 'rzp_test_key',
      subscriptionId: 'sub_test_1',
      name: 'Paqt',
      description: 'Pro plan',
    });
    await flush();
    (lastOptions().handler as () => void)();
    await promise;
    expect(lastOptions().subscription_id).toBe('sub_test_1');
    expect(lastOptions().key).toBe('rzp_test_key');
  });

  it('resolves with paid after the SDK success handler fires', async () => {
    const { Ctor, lastOptions } = fakeCtor();
    setRazorpayCtorForTest(Ctor as never);
    const promise = openSubscriptionCheckout({
      key: 'k',
      subscriptionId: 's',
      name: 'n',
      description: 'd',
    });
    await flush();
    (lastOptions().handler as () => void)();
    await expect(promise).resolves.toBe('paid');
  });

  it('resolves with dismissed when the modal is dismissed', async () => {
    const { Ctor, lastOptions } = fakeCtor();
    setRazorpayCtorForTest(Ctor as never);
    const promise = openSubscriptionCheckout({
      key: 'k',
      subscriptionId: 's',
      name: 'n',
      description: 'd',
    });
    await flush();
    const dismiss = (lastOptions().modal as { ondismiss?: () => void }).ondismiss;
    dismiss?.();
    await expect(promise).resolves.toBe('dismissed');
  });
});
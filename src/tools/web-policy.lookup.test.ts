import { describe, expect, it, vi } from 'vitest';

// A resolver that answers with no addresses and no error, which `dns.lookup` does not normally do
// but a hint filter or a custom resolver can.
vi.mock('node:dns', () => ({
  lookup: (
    _hostname: string,
    _options: unknown,
    callback: (error: Error | null, addresses: unknown[]) => void,
  ) => callback(null, []),
}));

const { connectionBlockedDestination, connectionBlockedReason, safeNetworkLookup } =
  await import('./web-policy.js');

describe('safeNetworkLookup with an empty answer', () => {
  it('fails as a resolution failure, not as a network-policy refusal', async () => {
    // Nothing private was involved, so the refusal must not become private_network_forbidden,
    // which would point the operator at the global private-network switch.
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      safeNetworkLookup('example.com', { all: true }, (lookupError) =>
        resolve(lookupError as NodeJS.ErrnoException | null),
      );
    });

    expect(error?.code).toBe('ENOTFOUND');
    expect(error?.message).toContain('example.com');
    expect(connectionBlockedReason(error)).toBeUndefined();
    expect(connectionBlockedDestination(error)).toBeUndefined();
  });

  it('never hands the single-address form an unvalidated empty destination', async () => {
    const result = await new Promise<{ error: unknown; address: unknown }>((resolve) => {
      safeNetworkLookup('example.com', { all: false }, (error, address) =>
        resolve({ error, address }),
      );
    });

    expect(result.error).toBeTruthy();
    expect(result.address).toBe('');
  });
});

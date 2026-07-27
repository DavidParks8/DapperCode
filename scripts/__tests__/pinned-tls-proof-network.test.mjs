import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSocketAddress } from '../pinned-tls-proof-network.mjs';

test('formats IPv4 and IPv6 proof bind addresses', () => {
  assert.equal(formatSocketAddress('100.64.0.1', 0), '100.64.0.1:0');
  assert.equal(formatSocketAddress('fd7a:115c:a1e0::1', 0), '[fd7a:115c:a1e0::1]:0');
  assert.equal(formatSocketAddress('[fd7a:115c:a1e0::1]', 443), '[fd7a:115c:a1e0::1]:443');
});

import { expect, test } from '@playwright/test';

import { startRealBridge } from '../harness/realBridge.ts';

test('production bridge instances own independent runtime boundaries', async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'phone',
    'The process-isolation contract only needs one run.',
  );

  const starts = await Promise.allSettled([
    startRealBridge(),
    startRealBridge(),
    startRealBridge(),
  ]);
  const bridges = starts.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failure = starts.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    await Promise.allSettled(bridges.map((bridge) => bridge.close()));
    throw failure.reason;
  }
  try {
    expect(new Set(bridges.map((bridge) => bridge.url)).size).toBe(bridges.length);
    expect(new Set(bridges.map((bridge) => bridge.token)).size).toBe(bridges.length);

    const statuses = await Promise.all(
      bridges.map((bridge) =>
        fetch(`${bridge.url}/status`, {
          headers: {
            Authorization: `Bearer ${bridge.token}`,
            Connection: 'close',
          },
        }),
      ),
    );
    expect(statuses.every((response) => response.ok)).toBe(true);
  } finally {
    await Promise.all(bridges.map((bridge) => bridge.close()));
  }
});

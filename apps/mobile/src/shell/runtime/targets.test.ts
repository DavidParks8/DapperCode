import { normalizeAppSettings } from '@shell/state/appState';
import { executionTargetForRoute, preferredTargetRoute } from './targets';

test('local selection survives normalization without changing legacy defaults or desktop routing', () => {
  expect(normalizeAppSettings({}).preferredExecutionTarget).toBe('bridge');
  const preferences = normalizeAppSettings({
    preferredExecutionTarget: 'on-device',
    showToolCalls: false,
  });
  expect(preferences.preferredExecutionTarget).toBe('on-device');
  expect(preferences.showToolCalls).toBe(false);
  expect(executionTargetForRoute('/on-device/chat/one', 'bridge')).toBe('on-device');
  expect(executionTargetForRoute('/profiles/one/chats/two', 'on-device')).toBe('bridge');
  expect(executionTargetForRoute('/', 'on-device')).toBe('on-device');
  expect(preferredTargetRoute('on-device', '/onboarding')).toBe('/on-device');
  expect(preferredTargetRoute('bridge', '/onboarding')).toBe('/onboarding');
});

export const BRIDGE_SETUP_INSTRUCTION =
  'Open the desktop companion on your Mac to set up and start the bundled bridge.';
export const BRIDGE_SETUP_URL =
  'https://github.com/DavidParks8/TetherCode/blob/main/docs/setup-and-operations.md';

export const SETUP_STAGES = [{ title: 'Start' }, { title: 'Pair' }, { title: 'Verify' }] as const;
export const INTRO_AGENT_MARKS = [{ label: 'ACP agents' }] as const;

export const INTRO_AGENT_ROTATION_MS = 1450;
export const INTRO_AGENT_FADE_MS = 120;
export const CONNECTION_CHECK_TIMEOUT_MS = 7_000;
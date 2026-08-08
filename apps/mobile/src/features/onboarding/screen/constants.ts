export const BRIDGE_SETUP_INSTRUCTION =
  'Open the desktop companion on your Mac to set up and start the bundled bridge.';
export const BRIDGE_SETUP_URL =
  'https://github.com/DavidParks8/DapperCode/blob/main/docs/setup-and-operations.md';

// Stage 3 reads "Save" to match the form section eyebrow and primary button label below it;
// it previously said "Verify" even though the step dock only reaches stage 3 once verification
// has already succeeded, which read as a mismatched, confusing label.
export const SETUP_STAGES = [{ title: 'Start' }, { title: 'Pair' }, { title: 'Save' }] as const;
// A broker connection may include the first workspace worker and ACP initialization.
export const CONNECTION_CHECK_TIMEOUT_MS = 70_000;

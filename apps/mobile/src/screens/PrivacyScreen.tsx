import { LegalScreen, type LegalSection } from './LegalScreen';

interface PrivacyScreenProps {
  policyUrl: string | null;
  onOpenDrawer: () => void;
}

const privacySections: readonly LegalSection[] = [
  {
    title: 'What This App Does',
    body: 'DapperCode connects to your own host bridge service and lets you view chats, run approved commands, and perform Git operations on your machine.',
  },
  {
    title: 'Data Processed',
    body: '- Chat messages and responses are sent between mobile and your bridge.\n- Terminal command text and output are sent to the bridge when you run commands.\n- Git status, diffs, and commit messages are returned from your repo.',
  },
  {
    title: 'Data Storage and Retention',
    body: '- Data is stored by services you run (harness caches, repo files, and logs).\n- This app does not define automatic cloud retention.\n- You control deletion by removing local bridge/cache/repo data.',
  },
  {
    title: 'Sharing',
    body: '- No ad SDKs are used in this app.\n- Data may be sent to model providers only when you run assistant workflows through your setup.\n- You are responsible for configuring and securing your bridge host and network.',
  },
  {
    title: 'Security Controls',
    body: '- Bridge token auth is enabled by default.\n- Terminal execution can be disabled or allowlisted server-side.\n- The bridge can be restricted to localhost and explicit CORS origins.',
  },
];

export function PrivacyScreen({ policyUrl, onOpenDrawer }: PrivacyScreenProps) {
  return (
    <LegalScreen
      title="Privacy"
      iconName="shield-checkmark"
      sections={privacySections}
      documentUrl={policyUrl}
      documentSectionLabel="Official Policy"
      documentLabel="Privacy policy URL"
      missingDocumentMessage="Not configured. Set EXPO_PUBLIC_PRIVACY_POLICY_URL."
      openButtonLabel="Open privacy policy"
      unsupportedDocumentMessage="The privacy policy URL is not supported on this device."
      openFailureMessage="Please open the policy URL manually."
      onOpenDrawer={onOpenDrawer}
    />
  );
}

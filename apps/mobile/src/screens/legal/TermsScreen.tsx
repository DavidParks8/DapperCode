import { LegalScreen, type LegalSection } from './LegalScreen';

interface TermsScreenProps {
  termsUrl: string | null;
  onOpenDrawer: () => void;
}

const termsSections: readonly LegalSection[] = [
  {
    title: 'Use Of Service',
    body: 'This mobile app is a client for interacting with a user-owned host bridge and repository. You are responsible for commands, commits, and approvals executed through your setup.',
  },
  {
    title: 'Account And Credentials',
    body: 'You must keep bridge tokens and provider credentials confidential. Do not share devices or hosts that have active bridge credentials without protection.',
  },
  {
    title: 'Acceptable Use',
    body: 'You may not use this app to access systems you do not own or have explicit authorization to control.',
  },
  {
    title: 'Operational Risk',
    body: 'Terminal and Git actions can change files and repository history on your host. Review commands and approvals before execution.',
  },
  {
    title: 'Availability And Changes',
    body: 'Features may change over time. You are responsible for maintaining your local bridge configuration and secure network setup.',
  },
];

export function TermsScreen({ termsUrl, onOpenDrawer }: TermsScreenProps) {
  return (
    <LegalScreen
      title="Terms"
      iconName="document-text"
      sections={termsSections}
      documentUrl={termsUrl}
      documentSectionLabel="Official Terms"
      documentLabel="Terms URL"
      missingDocumentMessage="Not configured. Set EXPO_PUBLIC_TERMS_OF_SERVICE_URL."
      openButtonLabel="Open terms"
      unsupportedDocumentMessage="The terms URL is not supported on this device."
      openFailureMessage="Please open the terms URL manually."
      onOpenDrawer={onOpenDrawer}
    />
  );
}

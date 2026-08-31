export type OnboardingMode = 'initial' | 'edit' | 'add' | 'reconnect';

export interface OnboardingBridgeProfileDraft {
  bridgeUrl: string;
  bridgeToken: string | null;
  workspaceId?: string | null;
}

export interface OnboardingScreenProps {
  mode?: OnboardingMode;
  initialBridgeUrl?: string | null;
  initialBridgeToken?: string | null;
  initialWorkspaceId?: string | null;
  allowInsecureRemoteBridge?: boolean;
  allowQueryTokenAuth?: boolean;
  onSave: (draft: OnboardingBridgeProfileDraft) => void | Promise<void>;
  onCancel?: () => void;
}

export type ConnectionCheck =
  | { kind: 'idle' }
  | { kind: 'success'; message: string; verifiedUrl: string; verifiedToken: string | null }
  | { kind: 'error'; message: string };

export type OnboardingStep = 'intro' | 'connect';

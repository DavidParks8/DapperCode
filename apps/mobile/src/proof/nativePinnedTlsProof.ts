import { requireOptionalNativeModule } from 'expo';

export type PinnedTlsIdentityReport = {
  spkiPin: string;
  hardwareBacked: boolean;
  simulatorSoftwareFallback: boolean;
  privateKeyExportFailed: boolean;
  storageClass: string;
  storageClassVerified: boolean;
  accessControl: string;
  accessControlVerified: boolean;
  wrapperRenewed: boolean;
  runID: string;
};

export type PinnedTlsProofReport = PinnedTlsIdentityReport & {
  deviceOSVersion: string;
  deploymentTarget: string;
  httpsPassed: boolean;
  wssPassed: boolean;
  httpsIdentityPresentedWithEmptyCAHints: boolean;
  wssIdentityPresentedWithEmptyCAHints: boolean;
  wrongServerPinRejected: boolean;
  wrongHostnameRejected: boolean;
  caSignedServerSubstitutionRejected: boolean;
  wrapperRenewalSPKIStable: boolean;
  reconnectPassed: boolean;
  promptCount: number | null;
  promptCountSource: 'pendingOperatorObservation' | 'operatorObserved' | 'simulatorNotObserved';
  tlsVersion: 'TLS1.3';
  hardwareGatePassed: boolean;
};

export type PinnedTlsLaunchConfiguration = {
  httpsURL: string;
  wssURL: string;
  hostname: string;
  serverSPKIPin: string;
  substitutionHTTPSURL: string;
  substitutionServerSPKIPin: string;
  automaticPromptCount: string;
  automaticPromptCountSource: string;
  requireNetworkTransition: string;
  runID: string;
};

type PinnedTlsProofNativeModule = {
  isRequested: boolean;
  launchConfiguration(): PinnedTlsLaunchConfiguration;
  prepareIdentity(): Promise<PinnedTlsIdentityReport>;
  runProof(
    httpsURL: string,
    wssURL: string,
    hostname: string,
    serverSPKIPin: string,
    substitutionHTTPSURL: string,
    substitutionServerSPKIPin: string,
    requireNetworkTransition: boolean,
  ): Promise<PinnedTlsProofReport>;
  finalizeProof(
    observedPromptCount: number,
    promptCountSource: 'operatorObserved' | 'simulatorNotObserved',
  ): Promise<PinnedTlsProofReport>;
};

export const pinnedTlsProofNativeModule = requireOptionalNativeModule<PinnedTlsProofNativeModule>(
  'DapperCodePinnedTlsProof',
);

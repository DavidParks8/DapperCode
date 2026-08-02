import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCameraPermissions } from 'expo-camera';

import { isInsecureRemoteUrl, normalizeBridgeUrlInput } from '../../bridgeUrl';
import { useAccessibilityAnnouncement } from '../../accessibility';
import { feedback } from '../../feedback';
import {
  useOnboardingIntroAnimations,
  type OnboardingHeroAnimatedStyle,
  type OnboardingTranslateAnimatedStyle,
} from './onboardingScreenAnimations';
import { parsePairingPayload } from './onboardingScreenPairing';
import { probeBridgeConnection } from './onboardingScreenProbe';
import type {
  ConnectionCheck,
  OnboardingBridgeProfileDraft,
  OnboardingMode,
  OnboardingStep,
} from './onboardingScreenTypes';

interface OnboardingControllerOptions {
  mode: OnboardingMode;
  initialBridgeUrl?: string | null;
  initialBridgeToken?: string | null;
  allowInsecureRemoteBridge: boolean;
  allowQueryTokenAuth: boolean;
  onSave: (draft: OnboardingBridgeProfileDraft) => void | Promise<void>;
}

export interface OnboardingController {
  onboardingStep: OnboardingStep;
  showIntroStep: boolean;
  showOnboardingDock: boolean;
  continueLabel: string;
  currentSetupStage: number;
  urlInput: string;
  tokenInput: string;
  tokenHidden: boolean;
  formError: string | null;
  checkingConnection: boolean;
  connectionCheck: ConnectionCheck;
  insecureRemoteWarning: string | null;
  scannerVisible: boolean;
  scannerError: string | null;
  scannerLocked: boolean;
  cameraPermissionGranted: boolean;
  introHeroAnimatedStyle: OnboardingHeroAnimatedStyle;
  introActionsAnimatedStyle: OnboardingTranslateAnimatedStyle;
  setUrlInput: (value: string) => void;
  setTokenInput: (value: string) => void;
  setTokenHidden: (updater: (previous: boolean) => boolean) => void;
  handleSave: () => Promise<void>;
  handleConnectionCheck: () => Promise<void>;
  goToConnectStep: () => void;
  goBackToIntro: () => void;
  openScanner: () => Promise<void>;
  closeScanner: () => void;
  handleBarcodeScanned: (data: string) => void;
}

export function useOnboardingScreenController(
  options: OnboardingControllerOptions,
): OnboardingController {
  const {
    mode,
    initialBridgeUrl,
    initialBridgeToken,
    allowInsecureRemoteBridge,
    allowQueryTokenAuth,
    onSave,
  } = options;

  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>(
    mode === 'initial' ? 'intro' : 'connect',
  );
  const [urlInput, setUrlInputState] = useState(initialBridgeUrl ?? '');
  const [tokenInput, setTokenInputState] = useState(initialBridgeToken ?? '');
  const [tokenHidden, setTokenHidden] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheck>({ kind: 'idle' });
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [scannerLocked, setScannerLocked] = useState(false);

  useEffect(() => {
    setOnboardingStep(mode === 'initial' ? 'intro' : 'connect');
  }, [mode]);

  // Bumped on every credential-changing action (typed edit, pairing payload, or a prop-driven
  // reset). `runConnectionCheck` captures this at request start and re-checks it before applying
  // its result, so a probe that resolves after the credentials it was testing have since changed
  // never overwrites the current state with a stale/mismatched outcome.
  const inputGenerationRef = useRef(0);
  const bumpInputGeneration = () => {
    inputGenerationRef.current += 1;
  };

  useEffect(() => {
    setUrlInputState(initialBridgeUrl ?? '');
    setConnectionCheck({ kind: 'idle' });
    bumpInputGeneration();
  }, [initialBridgeUrl]);

  useEffect(() => {
    setTokenInputState(initialBridgeToken ?? '');
    setConnectionCheck({ kind: 'idle' });
    bumpInputGeneration();
  }, [initialBridgeToken]);

  const showIntroStep = mode === 'initial' && onboardingStep === 'intro';
  const { introHeroAnimatedStyle, introActionsAnimatedStyle } = useOnboardingIntroAnimations(
    showIntroStep,
    mode,
  );

  const normalizedBridgeUrl = useMemo(() => normalizeBridgeUrlInput(urlInput), [urlInput]);
  const insecureRemoteWarning = useMemo(() => {
    if (!normalizedBridgeUrl || allowInsecureRemoteBridge) {
      return null;
    }

    return isInsecureRemoteUrl(normalizedBridgeUrl)
      ? 'This is plain HTTP over a non-private host. Use HTTPS/WSS when crossing untrusted networks.'
      : null;
  }, [allowInsecureRemoteBridge, normalizedBridgeUrl]);

  const normalizedTokenPreview = tokenInput.trim();
  const showOnboardingDock = mode === 'initial';
  const continueLabel =
    mode === 'edit' ? 'Save URL' : mode === 'reconnect' ? 'Reconnect' : 'Continue';
  const currentSetupStage = useMemo(() => {
    if (showIntroStep) {
      return 1;
    }
    if (connectionCheck.kind === 'success') {
      return 3;
    }
    if (normalizedBridgeUrl || normalizedTokenPreview) {
      return 2;
    }
    return 1;
  }, [connectionCheck.kind, normalizedBridgeUrl, normalizedTokenPreview, showIntroStep]);

  const validateInput = useCallback((): { bridgeUrl: string; bridgeToken: string } | null => {
    const normalized = normalizeBridgeUrlInput(urlInput);
    if (!normalized) {
      setFormError('Enter a valid URL. Example: http://100.101.102.103:8787');
      return null;
    }

    const normalizedToken = tokenInput.trim();
    if (!normalizedToken) {
      setFormError('Connection token is required.');
      return null;
    }

    setFormError(null);
    return { bridgeUrl: normalized, bridgeToken: normalizedToken };
  }, [tokenInput, urlInput]);

  const normalizeTokenInput = useCallback((value: string): string | null => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }, []);

  const runConnectionCheck = useCallback(
    async (normalized: string, token: string | null): Promise<boolean> => {
      const generation = inputGenerationRef.current;
      setCheckingConnection(true);
      setConnectionCheck({ kind: 'idle' });

      try {
        const result = await probeBridgeConnection({
          normalizedUrl: normalized,
          token,
          allowQueryTokenAuth,
        });
        if (!result.ok) {
          throw new Error('probe failed');
        }
        if (inputGenerationRef.current !== generation) {
          // The URL/token have changed since this probe started; discard the stale result
          // instead of showing a success message for credentials the user has since edited.
          return false;
        }

        setConnectionCheck({
          kind: 'success',
          message: result.healthCheckError
            ? 'Connected. Authenticated RPC verified; /health endpoint did not return 200.'
            : 'Connected. URL and token both verified.',
          verifiedUrl: normalized,
          verifiedToken: token,
        });
        void feedback.success();
        return true;
      } catch {
        if (inputGenerationRef.current !== generation) {
          return false;
        }
        setConnectionCheck({
          kind: 'error',
          message: 'Connection error. Check the URL and token, then try again.',
        });
        void feedback.error();
        return false;
      } finally {
        if (inputGenerationRef.current === generation) {
          setCheckingConnection(false);
        }
      }
    },
    [allowQueryTokenAuth],
  );

  const handleSave = useCallback(async () => {
    const validated = validateInput();
    if (!validated) {
      void feedback.warning();
      return;
    }

    const normalizedToken = normalizeTokenInput(validated.bridgeToken);
    // A prior "Test Connection" is only reused when it verified these exact, current url/token
    // values. Any edit — including one that raced with an in-flight probe — either resets
    // connectionCheck to idle synchronously or is caught by runConnectionCheck's generation
    // guard, so a lingering `success` here is guaranteed to match validated.bridgeUrl/token.
    const alreadyVerified =
      connectionCheck.kind === 'success' &&
      connectionCheck.verifiedUrl === validated.bridgeUrl &&
      connectionCheck.verifiedToken === normalizedToken;
    const ok = alreadyVerified ? true : await runConnectionCheck(validated.bridgeUrl, normalizedToken);
    if (!ok) {
      return;
    }

    try {
      await onSave({ bridgeUrl: validated.bridgeUrl, bridgeToken: normalizedToken });
    } catch (error) {
      setConnectionCheck({
        kind: 'error',
        message: (error as Error).message || 'Saving the connection failed.',
      });
      void feedback.error();
    }
  }, [connectionCheck, normalizeTokenInput, onSave, runConnectionCheck, validateInput]);

  const handleConnectionCheck = useCallback(async () => {
    const validated = validateInput();
    if (!validated) {
      setConnectionCheck({ kind: 'idle' });
      void feedback.warning();
      return;
    }

    const normalizedToken = normalizeTokenInput(validated.bridgeToken);
    await runConnectionCheck(validated.bridgeUrl, normalizedToken);
  }, [normalizeTokenInput, runConnectionCheck, validateInput]);

  const goToConnectStep = useCallback(() => {
    void feedback.selection();
    setOnboardingStep('connect');
  }, []);

  const goBackToIntro = useCallback(() => {
    void feedback.selection();
    setOnboardingStep('intro');
    setFormError(null);
    setConnectionCheck({ kind: 'idle' });
  }, []);

  const closeScanner = useCallback(() => {
    void feedback.selection();
    setScannerVisible(false);
    setScannerLocked(false);
    setScannerError(null);
  }, []);

  const openScanner = useCallback(async () => {
    setFormError(null);
    setConnectionCheck({ kind: 'idle' });
    setScannerError(null);

    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        setFormError('Camera permission is required to scan the pairing QR.');
        void feedback.error();
        return;
      }
    }

    void feedback.selection();
    setScannerLocked(false);
    setScannerVisible(true);
  }, [cameraPermission?.granted, requestCameraPermission]);

  const applyPairingPayload = useCallback(
    (pairingData: { bridgeToken: string; bridgeUrl?: string }) => {
      if (pairingData.bridgeUrl) {
        setUrlInputState(pairingData.bridgeUrl);
      }
      setTokenInputState(pairingData.bridgeToken);
      setFormError(null);
      setConnectionCheck({ kind: 'idle' });
      setScannerError(null);
      setScannerLocked(false);
      setScannerVisible(false);
      bumpInputGeneration();
    },
    [],
  );

  const handleBarcodeScanned = useCallback(
    (data: string) => {
      if (scannerLocked) {
        return;
      }

      setScannerLocked(true);
      const pairing = parsePairingPayload(data);
      if (!pairing) {
        setScannerError('QR code is not a valid DapperCode bridge pairing code.');
        void feedback.warning();
        setTimeout(() => {
          setScannerLocked(false);
        }, 1200);
        return;
      }

      void feedback.success();
      applyPairingPayload(pairing);
    },
    [applyPairingPayload, scannerLocked],
  );

  useAccessibilityAnnouncement(formError ?? scannerError);
  useAccessibilityAnnouncement(
    checkingConnection
      ? 'Testing bridge connection'
      : connectionCheck.kind === 'success'
        ? connectionCheck.message
        : null,
  );

  return {
    onboardingStep,
    showIntroStep,
    showOnboardingDock,
    continueLabel,
    currentSetupStage,
    urlInput,
    tokenInput,
    tokenHidden,
    formError,
    checkingConnection,
    connectionCheck,
    insecureRemoteWarning,
    scannerVisible,
    scannerError,
    scannerLocked,
    cameraPermissionGranted: Boolean(cameraPermission?.granted),
    introHeroAnimatedStyle,
    introActionsAnimatedStyle,
    setUrlInput: (value: string) => {
      setUrlInputState(value);
      setFormError(null);
      setConnectionCheck({ kind: 'idle' });
      bumpInputGeneration();
    },
    setTokenInput: (value: string) => {
      setTokenInputState(value);
      setConnectionCheck({ kind: 'idle' });
      bumpInputGeneration();
    },
    setTokenHidden: (updater: (previous: boolean) => boolean) => {
      void feedback.selection();
      setTokenHidden(updater);
    },
    handleSave,
    handleConnectionCheck,
    goToConnectStep,
    goBackToIntro,
    openScanner,
    closeScanner,
    handleBarcodeScanned,
  };
}

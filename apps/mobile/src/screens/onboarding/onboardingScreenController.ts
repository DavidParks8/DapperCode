import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCameraPermissions } from 'expo-camera';

import { isInsecureRemoteUrl, normalizeBridgeUrlInput } from '../../bridgeUrl';
import { useAccessibilityAnnouncement } from '../../accessibility';
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

  useEffect(() => {
    setUrlInputState(initialBridgeUrl ?? '');
  }, [initialBridgeUrl]);

  useEffect(() => {
    setTokenInputState(initialBridgeToken ?? '');
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

        setConnectionCheck({
          kind: 'success',
          message: result.healthCheckError
            ? 'Connected. Authenticated RPC verified; /health endpoint did not return 200.'
            : 'Connected. URL and token both verified.',
        });
        return true;
      } catch {
        setConnectionCheck({
          kind: 'error',
          message: 'Connection error. Check the URL and token, then try again.',
        });
        return false;
      } finally {
        setCheckingConnection(false);
      }
    },
    [allowQueryTokenAuth],
  );

  const handleSave = useCallback(async () => {
    const validated = validateInput();
    if (!validated) {
      return;
    }

    const normalizedToken = normalizeTokenInput(validated.bridgeToken);
    const ok = await runConnectionCheck(validated.bridgeUrl, normalizedToken);
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
    }
  }, [normalizeTokenInput, onSave, runConnectionCheck, validateInput]);

  const handleConnectionCheck = useCallback(async () => {
    const validated = validateInput();
    if (!validated) {
      setConnectionCheck({ kind: 'idle' });
      return;
    }

    const normalizedToken = normalizeTokenInput(validated.bridgeToken);
    await runConnectionCheck(validated.bridgeUrl, normalizedToken);
  }, [normalizeTokenInput, runConnectionCheck, validateInput]);

  const goToConnectStep = useCallback(() => {
    setOnboardingStep('connect');
  }, []);

  const goBackToIntro = useCallback(() => {
    setOnboardingStep('intro');
    setFormError(null);
    setConnectionCheck({ kind: 'idle' });
  }, []);

  const closeScanner = useCallback(() => {
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
        return;
      }
    }

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
        setTimeout(() => {
          setScannerLocked(false);
        }, 1200);
        return;
      }

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
    },
    setTokenInput: (value: string) => {
      setTokenInputState(value);
      setConnectionCheck({ kind: 'idle' });
    },
    setTokenHidden,
    handleSave,
    handleConnectionCheck,
    goToConnectStep,
    goBackToIntro,
    openScanner,
    closeScanner,
    handleBarcodeScanned,
  };
}

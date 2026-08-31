import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';

import { feedback } from '@shared/feedback';

const COPY_STATUS_RESET_MS = 1_600;

export type CopyStatus = 'idle' | 'copied' | 'error';

export function useCopyText(value: string) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const copy = useCallback(() => {
    void Clipboard.setStringAsync(value)
      .then(() => {
        void feedback.success();
        setCopyStatus('copied');
        clearResetTimer();
        resetTimerRef.current = setTimeout(() => {
          resetTimerRef.current = null;
          setCopyStatus('idle');
        }, COPY_STATUS_RESET_MS);
      })
      .catch(() => {
        setCopyStatus('error');
      });
  }, [clearResetTimer, value]);

  return {
    copy,
    copyStatus,
    copyLabel: copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? 'Retry' : 'Copy',
    accessibilityLabel:
      copyStatus === 'copied'
        ? 'Code copied'
        : copyStatus === 'error'
          ? 'Copy failed. Try again'
          : 'Copy code',
  };
}

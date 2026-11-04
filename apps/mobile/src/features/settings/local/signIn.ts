import * as Clipboard from 'expo-clipboard';
import { atom, type createStore } from 'jotai';
import { AccessibilityInfo } from 'react-native';

import { GitAuthenticationError, type GitDeviceAuthorization } from '../../on-device/auth/strategy';
import type { OnDeviceRuntime } from '../../on-device/runtime/runtime';

type Store = ReturnType<typeof createStore>;

export interface LocalSignInState {
  /** The runtime the attempt belongs to; a new runtime never inherits a stale attempt. */
  runtime: OnDeviceRuntime | null;
  phase: 'idle' | 'requesting' | 'waiting';
  authorization: GitDeviceAuthorization | null;
  /** True once the code was placed on the clipboard automatically. */
  copied: boolean;
  error: string | null;
}

export const IDLE_SIGN_IN: LocalSignInState = {
  runtime: null,
  phase: 'idle',
  authorization: null,
  copied: false,
  error: null,
};

/**
 * GitHub device-flow progress. It lives outside the Settings page so leaving the page never
 * cancels or loses an in-progress sign-in; returning shows the same code again.
 */
export const localSignInAtom = atom<LocalSignInState>(IDLE_SIGN_IN);

function signInError(error: unknown): string {
  if (error instanceof GitAuthenticationError || error instanceof Error) {
    return error.message || 'GitHub sign-in failed. Try again.';
  }
  return 'GitHub sign-in failed. Try again.';
}

/** Starts sign-in for `runtime`. The code is shown and copied; GitHub opens only on request. */
export function startLocalSignIn(store: Store, runtime: OnDeviceRuntime): void {
  const current = store.get(localSignInAtom);
  if (current.runtime === runtime && current.phase !== 'idle') {
    return;
  }
  const owns = () => store.get(localSignInAtom).runtime === runtime;
  store.set(localSignInAtom, { ...IDLE_SIGN_IN, runtime, phase: 'requesting' });
  runtime
    .signIn(async (authorization) => {
      if (!owns()) {
        return;
      }
      store.set(localSignInAtom, {
        ...store.get(localSignInAtom),
        phase: 'waiting',
        authorization,
      });
      const copied = await Clipboard.setStringAsync(authorization.userCode).catch(() => false);
      if (owns() && store.get(localSignInAtom).authorization === authorization) {
        store.set(localSignInAtom, { ...store.get(localSignInAtom), copied: copied !== false });
      }
    })
    .then(() => {
      if (owns()) {
        store.set(localSignInAtom, { ...IDLE_SIGN_IN, runtime });
        // Announced once, when it happens; the signed-in row states it from then on.
        const login = runtime.preferences().account?.login;
        if (login) {
          AccessibilityInfo.announceForAccessibility(`Signed in to GitHub as ${login}.`);
        }
      }
    })
    .catch((error: unknown) => {
      if (!owns()) {
        return;
      }
      const cancelled =
        store.get(localSignInAtom).phase === 'idle' ||
        (error instanceof GitAuthenticationError && error.code === 'cancelled');
      store.set(localSignInAtom, {
        ...IDLE_SIGN_IN,
        runtime,
        error: cancelled ? null : signInError(error),
      });
    });
}

/** Cancels the in-progress sign-in, if any. */
export function cancelLocalSignIn(store: Store, runtime: OnDeviceRuntime): void {
  if (store.get(localSignInAtom).runtime !== runtime) {
    return;
  }
  store.set(localSignInAtom, { ...IDLE_SIGN_IN, runtime });
  runtime.authentication.cancelSignIn();
}

/** Forgets the last attempt's code and error, for example after signing out. */
export function resetLocalSignIn(store: Store, runtime: OnDeviceRuntime): void {
  if (store.get(localSignInAtom).runtime === runtime) {
    store.set(localSignInAtom, { ...IDLE_SIGN_IN, runtime });
  }
}

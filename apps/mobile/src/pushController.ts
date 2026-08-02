import * as Crypto from 'expo-crypto';

import type { HostBridgeApiClient } from './api/client';
import type { PushSettingsState } from './appState';
import { requestPushRegistration } from './pushNotifications';
import { dispatchDurableAppStateAtom } from './state/appState/actions';
import { pushSettingsAtom } from './state/appState/atoms';
import type { AppStore } from './state/types';

export type PushSyncResult =
  { status: 'registered'; token: string } | { status: 'optedOut' } | { status: 'unavailable' };

export async function syncPushRegistration(
  api: HostBridgeApiClient,
  store: AppStore,
  profileId: string,
): Promise<PushSyncResult> {
  const initialSettings = store.get(pushSettingsAtom);
  let registration = initialSettings.registrations.find((entry) => entry.profileId === profileId);
  if (initialSettings.optedOut && !registration) {
    return { status: 'optedOut' };
  }
  if (!registration) {
    const registrationId = `push-${Crypto.randomUUID()}`;
    const state = await store.set(dispatchDurableAppStateAtom, {
      type: 'push/ensure-registration',
      profileId,
      registrationId,
    });
    registration = state.push.registrations.find((entry) => entry.profileId === profileId);
  }
  if (!registration) {
    throw new Error('Could not create a push registration identity.');
  }

  const settings = store.get(pushSettingsAtom);
  if (settings.optedOut) {
    if (registration.token) {
      await api.unregisterPushDevice({
        profileId: registration.profileId,
        registrationId: registration.registrationId,
      });
      await store.set(dispatchDurableAppStateAtom, {
        type: 'push/unregistered',
        profileId: registration.profileId,
        registrationId: registration.registrationId,
      });
    }
    return { status: 'optedOut' };
  }

  const token = await requestPushRegistration();
  if (!token) {
    return { status: 'unavailable' };
  }

  await api.registerPushDevice({
    profileId: registration.profileId,
    registrationId: registration.registrationId,
    token: token.token,
    platform: token.platform,
    deviceName: token.deviceName,
    events: settings.events,
  });
  await store.set(dispatchDurableAppStateAtom, {
    type: 'push/registered',
    profileId: registration.profileId,
    registrationId: registration.registrationId,
    token: token.token,
  });
  return { status: 'registered', token: token.token };
}

export async function enablePush(
  api: HostBridgeApiClient,
  store: AppStore,
  profileId: string,
): Promise<PushSyncResult> {
  await store.set(dispatchDurableAppStateAtom, { type: 'push/update', patch: { optedOut: false } });
  return syncPushRegistration(api, store, profileId);
}

export async function disablePush(
  api: HostBridgeApiClient,
  store: AppStore,
  profileId: string,
): Promise<void> {
  await store.set(dispatchDurableAppStateAtom, { type: 'push/update', patch: { optedOut: true } });
  await syncPushRegistration(api, store, profileId);
}

export async function updatePushEvents(
  api: HostBridgeApiClient,
  store: AppStore,
  profileId: string,
  events: PushSettingsState['events'],
): Promise<void> {
  const state = await store.set(dispatchDurableAppStateAtom, {
    type: 'push/update',
    patch: { events },
  });
  if (!state.push.optedOut) {
    await syncPushRegistration(api, store, profileId);
  }
}

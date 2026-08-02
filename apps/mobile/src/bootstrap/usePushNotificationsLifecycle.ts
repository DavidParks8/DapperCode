import { useAtomValue, useStore } from 'jotai';
import { useEffect, useRef } from 'react';

import {
  addNotificationResponseListener,
  getInitialNotificationResponse,
  registerNotificationCategories,
  setupNotificationHandler,
  type PushResponseEvent,
} from '../pushNotifications';
import { PushResponseController } from '../pushResponseController';
import { pushSettingsAtom } from '../state/appState/atoms';
import { activeBridgeProfileAtom, apiClientAtom, wsClientAtom } from '../state/bridge/atoms';
import { pendingMainChatIdAtom, pendingMainChatSnapshotAtom } from '../state/chat/atoms';
import { routes } from '../navigation/routes';
import { replaceRoot } from '../navigation/routeNavigation';

export function usePushNotificationsLifecycle(): void {
  const store = useStore();
  const api = useAtomValue(apiClientAtom);
  const ws = useAtomValue(wsClientAtom);
  const registrations = useAtomValue(pushSettingsAtom).registrations;
  const activeBridgeProfileId = useAtomValue(activeBridgeProfileAtom)?.id ?? null;
  const controllerRef = useRef<PushResponseController | null>(null);

  useEffect(() => {
    setupNotificationHandler();
    void registerNotificationCategories();
    const controller = new PushResponseController((event: PushResponseEvent) => {
      const { target } = event;
      if (target.threadId) {
        store.set(pendingMainChatIdAtom, target.threadId);
        store.set(pendingMainChatSnapshotAtom, null);
        replaceRoot(routes.chat(target.profileId, target.threadId));
      }
    });
    controllerRef.current = controller;

    const subscription = addNotificationResponseListener((event) => controller.handle(event));
    void getInitialNotificationResponse().then((event) => {
      if (event) {
        controller.handle(event);
      }
    });
    return () => {
      subscription.remove();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [store]);

  useEffect(() => {
    const registration = registrations.find((entry) => entry.profileId === activeBridgeProfileId);
    controllerRef.current?.setProfile(
      activeBridgeProfileId && registration && api && ws
        ? {
            profileId: activeBridgeProfileId,
            registrationId: registration.registrationId,
            api,
            ws,
          }
        : null,
    );
  }, [activeBridgeProfileId, api, registrations, ws]);
}

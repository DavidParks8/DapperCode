import { screenSetter } from '../../state/mainScreen/registry';
import {
  activityAtom,
  bridgeRecoveryBannerVisibleAtom
} from '../../state/mainScreen/composer';
import type { RpcNotification } from '../../api/types';
import { toRecord, readString } from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';


export function processBridgeConnectionEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null
): void {
  const {
    clearDeferredDisconnectActivity,
    clearRunWatchdog,
    loadChat,
    appStateRef,
    scheduleDisconnectActivity,
    store,
  } = context;
  const setActivity = screenSetter(store, activityAtom);
  const setBridgeRecoveryBannerVisible = screenSetter(store, bridgeRecoveryBannerVisibleAtom);

      if (event.method === 'bridge/connection/state') {
        const params = toRecord(event.params);
        const status = readString(params?.status);
        if (status === 'connected') {
          clearDeferredDisconnectActivity();
          setBridgeRecoveryBannerVisible(false);
          if (!currentId) {
            return;
          }
          setActivity((prev) =>
            prev.tone === 'running'
              ? prev
              : {
                  tone: 'idle',
                  title: 'Connected',
                }
          );
          clearRunWatchdog();
          loadChat(currentId, { preserveRuntimeState: true }).catch(() => {});
          return;
        }

        if (status === 'disconnected') {
          clearRunWatchdog();
          if (appStateRef.current !== 'active') {
            clearDeferredDisconnectActivity();
            return;
          }
          scheduleDisconnectActivity();
        }
      }
}

import { useRouter } from 'expo-router';
import { useSetAtom } from 'jotai';

import { dispatchDurableAppStateAtom } from '@shell/state/appState/actions';
import { LocalAction, LocalError, useLocalOperation } from '../../features/on-device/screens/ui';

export function ReturnToDesktop() {
  const dispatch = useSetAtom(dispatchDurableAppStateAtom);
  const router = useRouter();
  const operation = useLocalOperation();
  return (
    <>
      <LocalAction
        title="Return to desktop connections"
        disabled={operation.busy}
        onPress={() =>
          operation.run(async () => {
            await dispatch({
              type: 'settings/update',
              patch: { preferredExecutionTarget: 'bridge' },
            });
            router.replace('/');
          })
        }
      />
      <LocalError message={operation.error} />
    </>
  );
}

import { useSetAtom } from 'jotai';
import { useRouter } from 'expo-router';
import { Platform } from 'react-native';

import { dispatchDurableAppStateAtom } from '@shell/state/appState/actions';
import { ChoiceAction } from '../../features/onboarding/ChoiceAction';
import { useLocalOperation, LocalError } from '../../features/on-device/screens/ui';

export function OnDeviceEntry() {
  const router = useRouter();
  const dispatch = useSetAtom(dispatchDurableAppStateAtom);
  const operation = useLocalOperation();
  if (Platform.OS !== 'ios') {
    return null;
  }
  return (
    <>
      <ChoiceAction
        title="On this iPhone"
        meta="Offline models with file and Git tools"
        iconName="phone-portrait-outline"
        loading={operation.busy}
        onPress={() =>
          operation.run(async () => {
            await dispatch({
              type: 'settings/update',
              patch: { preferredExecutionTarget: 'on-device' },
            });
            router.replace('/on-device');
          })
        }
      />
      <LocalError message={operation.error} />
    </>
  );
}

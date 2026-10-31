import { Redirect, useLocalSearchParams } from 'expo-router';

import { legacyOnDeviceHref } from '@shell/navigation/legacyOnDeviceLinks';

/** Links into the retired on-device screens open the matching On this iPhone profile route. */
export default function LegacyOnDeviceLink() {
  const { path } = useLocalSearchParams<{ path?: string | string[] }>();
  return <Redirect href={legacyOnDeviceHref(path)} />;
}

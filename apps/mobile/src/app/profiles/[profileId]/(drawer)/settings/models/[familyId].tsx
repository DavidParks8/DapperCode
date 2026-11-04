import { LocalModelFamilyScreen } from '../../../../../../features/settings/local/LocalModelFamilyScreen';
import { LocalSettingsRoute } from '../../../../../../features/settings/local/LocalSettingsRoute';

export default function LocalModelFamilyRoute() {
  return (
    <LocalSettingsRoute>
      <LocalModelFamilyScreen />
    </LocalSettingsRoute>
  );
}

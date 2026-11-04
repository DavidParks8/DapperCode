import { LocalModelsScreen } from '../../../../../../features/settings/local/LocalModelsScreen';
import { LocalSettingsRoute } from '../../../../../../features/settings/local/LocalSettingsRoute';

export default function LocalModelsRoute() {
  return (
    <LocalSettingsRoute>
      <LocalModelsScreen />
    </LocalSettingsRoute>
  );
}

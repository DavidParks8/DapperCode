import { LocalGitAccountScreen } from '../../../../../features/settings/local/LocalGitAccountScreen';
import { LocalSettingsRoute } from '../../../../../features/settings/local/LocalSettingsRoute';

export default function LocalGitAccountRoute() {
  return (
    <LocalSettingsRoute>
      <LocalGitAccountScreen />
    </LocalSettingsRoute>
  );
}

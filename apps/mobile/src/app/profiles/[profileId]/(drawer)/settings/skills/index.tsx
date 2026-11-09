import { LocalSettingsRoute } from '../../../../../../features/settings/local/LocalSettingsRoute';
import { LocalSkillsScreen } from '../../../../../../features/settings/local/LocalSkillsScreen';

export default function LocalSkillsRoute() {
  return (
    <LocalSettingsRoute>
      <LocalSkillsScreen />
    </LocalSettingsRoute>
  );
}

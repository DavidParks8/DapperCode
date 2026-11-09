import { LocalSettingsRoute } from '../../../../../../../features/settings/local/LocalSettingsRoute';
import { LocalSkillInfoScreen } from '../../../../../../../features/settings/local/LocalSkillInfoScreen';

export default function LocalSkillInfoRoute() {
  return (
    <LocalSettingsRoute>
      <LocalSkillInfoScreen />
    </LocalSettingsRoute>
  );
}

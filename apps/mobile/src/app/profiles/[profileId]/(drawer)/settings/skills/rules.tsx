import { LocalSettingsRoute } from '../../../../../../features/settings/local/LocalSettingsRoute';
import { LocalSkillRulesScreen } from '../../../../../../features/settings/local/LocalSkillRulesScreen';

export default function LocalSkillRulesRoute() {
  return (
    <LocalSettingsRoute>
      <LocalSkillRulesScreen />
    </LocalSettingsRoute>
  );
}

import { LocalSettingsRoute } from '../../../../../../features/settings/local/LocalSettingsRoute';
import { LocalSkillCatalogsScreen } from '../../../../../../features/settings/local/LocalSkillCatalogsScreen';

export default function LocalSkillCatalogsRoute() {
  return (
    <LocalSettingsRoute>
      <LocalSkillCatalogsScreen />
    </LocalSettingsRoute>
  );
}

import { LocalSettingsRoute } from '../../../../../../features/settings/local/LocalSettingsRoute';
import { LocalSkillImportScreen } from '../../../../../../features/settings/local/LocalSkillImportScreen';

export default function LocalSkillImportRoute() {
  return (
    <LocalSettingsRoute>
      <LocalSkillImportScreen />
    </LocalSettingsRoute>
  );
}

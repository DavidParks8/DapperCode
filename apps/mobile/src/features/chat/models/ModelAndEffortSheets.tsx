import { router } from 'expo-router';
import { useAtomValue } from 'jotai';

import { SelectionSheet, type SelectionSheetOption } from '@shared/ui/SelectionSheet';
import { routes } from '@shell/navigation/routes';
import { activeProfileFeaturesAtom, activeProfileIdAtom } from '@shell/state/bridge/atoms';
import { loadingModelsAtom } from '../state/models';
import { effortModalVisibleAtom, modelModalVisibleAtom } from '../state/modals';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from '../screen/panelCollapseCoordinator';

type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

const AGENT_MODEL_COPY = {
  subtitle:
    'Choose the model for this session. Available capabilities and defaults come from the connected agent.',
  emptyLabel: 'No models are available from the connected agent.',
};

const DEVICE_MODEL_COPY = {
  subtitle:
    'Downloaded models run on this iPhone. The chosen model loads when you send and stays loaded between turns.',
  emptyLabel: 'No models are downloaded yet. Download one to start chatting.',
};

export const MANAGE_DEVICE_MODELS_KEY = 'manage-device-models';

export function MainScreenModelAndEffortSheets({ context }: { context: Context }) {
  const {
    activeModelLabel,
    closeEffortModal,
    closeModelModal,
    effortPickerSheetOptions,
    modelPickerOptions,
  } = context;
  const loadingModels = useAtomValue(loadingModelsAtom);
  const modelModalVisible = useAtomValue(modelModalVisibleAtom);
  const effortModalVisible = useAtomValue(effortModalVisibleAtom);
  const { modelLibrary } = useAtomValue(activeProfileFeaturesAtom);
  const profileId = useAtomValue(activeProfileIdAtom);
  const copy = modelLibrary ? DEVICE_MODEL_COPY : AGENT_MODEL_COPY;
  const manageModels: SelectionSheetOption[] =
    modelLibrary && profileId
      ? [
          {
            key: MANAGE_DEVICE_MODELS_KEY,
            title: modelPickerOptions.length > 0 ? 'Download more models' : 'Download a model',
            description: 'Browse, download, load, and delete models in Settings.',
            icon: 'cloud-download-outline',
            tone: 'accent',
            onPress: () => {
              closeModelModal();
              router.push(routes.settingsModels(profileId));
            },
          },
        ]
      : [];

  return (
    <>
      <SelectionSheet
        visible={modelModalVisible}
        title="Choose a model"
        subtitle={copy.subtitle}
        options={[...modelPickerOptions, ...manageModels]}
        loading={loadingModels}
        loadingLabel="Refreshing available models…"
        emptyLabel={copy.emptyLabel}
        presentation="expanded"
        onClose={closeModelModal}
      />
      <SelectionSheet
        visible={effortModalVisible}
        title="Set thinking level"
        subtitle={`Choose how much reasoning ${activeModelLabel} should use.`}
        options={effortPickerSheetOptions}
        onClose={closeEffortModal}
      />
    </>
  );
}

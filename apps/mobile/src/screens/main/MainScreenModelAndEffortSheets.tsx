import { useAtomValue } from 'jotai';

import { SelectionSheet } from '../../components/SelectionSheet';
import { loadingModelsAtom } from '../../state/mainScreen/models';
import { effortModalVisibleAtom, modelModalVisibleAtom } from '../../state/mainScreen/modals';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './mainScreenPanelCollapseCoordinator';

type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

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

  return (
    <>
      <SelectionSheet
        visible={modelModalVisible}
        title="Choose a model"
        subtitle="Choose the model for this session. Available capabilities and defaults come from the connected agent."
        options={modelPickerOptions}
        loading={loadingModels}
        loadingLabel="Refreshing available models…"
        emptyLabel="No models are available from the connected agent."
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

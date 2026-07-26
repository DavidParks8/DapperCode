import { screenAtom } from './registry';

export const titleModalVisibleAtom = screenAtom(false);

export const titleDraftAtom = screenAtom('');

export const titleSavingAtom = screenAtom(false);

export const agentThreadMenuVisibleAtom = screenAtom(false);

export const modelModalVisibleAtom = screenAtom(false);

export const agentModalVisibleAtom = screenAtom(false);

export const collaborationModeMenuVisibleAtom = screenAtom(false);

export const effortModalVisibleAtom = screenAtom(false);

export const effortPickerModelIdAtom = screenAtom<string | null>(null);

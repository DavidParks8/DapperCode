import type { ChatSummary } from '@bridge/types/types';
import { createDrawerContentAtoms } from '@shell/state/drawer/contentAtoms';
import { createTestStore } from '@shell/state/testing';

function createChat(id: string, cwd: string): ChatSummary {
  return {
    id,
    title: `Chat ${id}`,
    status: 'complete',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    statusUpdatedAt: '2026-08-15T00:00:00.000Z',
    lastMessagePreview: 'done',
    cwd,
  };
}

describe('drawer content atom subscriptions', () => {
  it('does not notify the footer for search, selection, or folder-filter changes', () => {
    const store = createTestStore();
    const atoms = createDrawerContentAtoms({
      profileId: 'profile-1',
      wsConnected: true,
    });
    store.set(atoms.chatStateAtom, {
      profileId: 'profile-1',
      chats: [createChat('alpha', '/repo/alpha'), createChat('beta', '/repo/beta')],
    });
    const folderKey = store.get(atoms.folderOptionsAtom).find((option) => option.key !== null)?.key;
    if (!folderKey) {
      throw new Error('Expected a selectable folder');
    }

    const footerChanged = jest.fn();
    const unsubscribe = store.sub(atoms.footerStateAtom, footerChanged);

    store.set(atoms.searchQueryAtom, 'alpha');
    store.set(atoms.selectionModeAtom, true);
    store.set(atoms.selectedFolderKeyAtom, folderKey);

    expect(footerChanged).not.toHaveBeenCalled();

    store.set(atoms.wsConnectedAtom, false);
    expect(footerChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps the list unsubscribed from folder-sheet visibility', () => {
    const store = createTestStore();
    const atoms = createDrawerContentAtoms({
      profileId: 'profile-1',
      wsConnected: true,
    });
    const listChanged = jest.fn();
    const unsubscribe = store.sub(atoms.listStateAtom, listChanged);

    store.set(atoms.folderPickerVisibleAtom, true);
    expect(listChanged).not.toHaveBeenCalled();

    store.set(atoms.searchQueryAtom, 'alpha');
    expect(listChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps collapsed-lane updates out of the header until search needs result counts', () => {
    const store = createTestStore();
    const atoms = createDrawerContentAtoms({
      profileId: 'profile-1',
      wsConnected: true,
    });
    const headerChanged = jest.fn();
    const unsubscribe = store.sub(atoms.headerStateAtom, headerChanged);

    store.set(atoms.collapsedLaneKeysAtom, new Set<'recent'>(['recent']));
    expect(headerChanged).not.toHaveBeenCalled();

    store.set(atoms.searchQueryAtom, 'alpha');
    store.set(atoms.collapsedLaneKeysAtom, new Set<'recent'>());
    expect(headerChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

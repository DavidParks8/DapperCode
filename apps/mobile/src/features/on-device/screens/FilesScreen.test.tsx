import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { LocalDirectoryListing } from '../workspaces/types';
import { LocalFilesScreen } from './FilesScreen';

let mockParams: { workspaceId?: string } = {};
jest.mock('expo-router', () => ({
  ...jest.requireActual('@shared/testing/expoRouterMock'),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@shell/layout/useShellLayout', () => ({
  useSceneHorizontalInsets: () => ({ paddingLeft: 0, paddingRight: 0 }),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('../runtime/OnDeviceProvider', () => ({ useOnDeviceRuntime: () => mockRuntime }));

const listings: Record<string, LocalDirectoryListing> = {
  '': {
    entries: [
      { name: 'README.md', kind: 'file', bytes: 12 },
      { name: 'src', kind: 'directory', bytes: 0 },
    ],
    truncated: false,
  },
  src: { entries: [{ name: 'main.ts', kind: 'file', bytes: 4 }], truncated: false },
};
let mockVersion = 0;
let token = 'token-0';
const mockRuntime = {
  version: () => mockVersion,
  workspaceTask: <T,>(_label: string, action: () => Promise<T>) => action(),
  native: {
    listWorkspaceFiles: jest.fn(async (_id: string, path: string) => {
      const listing = listings[path];
      if (!listing) {
        throw new Error('[ondevice:PATH_OUTSIDE_WORKSPACE] Unexpected path');
      }
      return listing;
    }),
    readWorkspaceFile: jest.fn(async (_id: string, path: string) => ({
      path,
      content: 'x'.repeat(65_536),
      revision: 'revision',
      nextOffset: 65_536,
      totalBytes: 200 * 1024,
    })),
    writeWorkspaceFile: jest.fn(async () => 'next'),
    renameWorkspaceEntry: jest.fn(async () => undefined),
    removeWorkspaceEntry: jest.fn(async () => undefined),
    getWorkspaceChangeToken: jest.fn(async () => token),
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { workspaceId: 'workspace' };
  mockVersion = 0;
  token = 'token-0';
});

test('the Files browser lists the workspace root with the empty root path', async () => {
  render(<LocalFilesScreen />);
  expect(await screen.findByText('README.md')).toBeTruthy();
  expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenCalledWith('workspace', '', 200);
  expect(mockRuntime.native.listWorkspaceFiles).not.toHaveBeenCalledWith('workspace', '.', 200);
  expect(screen.getByText('Workspace root')).toBeTruthy();
  expect(screen.queryByText('Parent folder')).toBeNull();
});

test('folders join without a dot prefix and new files are created in the current folder', async () => {
  render(<LocalFilesScreen />);
  fireEvent.press(await screen.findByText('Folder: src'));
  expect(await screen.findByText('main.ts')).toBeTruthy();
  expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenLastCalledWith('workspace', 'src', 200);
  fireEvent.changeText(screen.getByLabelText('New file name'), 'new.ts');
  fireEvent.press(screen.getByText('Create empty file'));
  await waitFor(() =>
    expect(mockRuntime.native.writeWorkspaceFile).toHaveBeenCalledWith(
      'workspace',
      'src/new.ts',
      '',
      null,
    ),
  );
  await waitFor(() => expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenCalledTimes(3));
  expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenLastCalledWith('workspace', 'src', 200);
  fireEvent.press(screen.getByText('Parent folder'));
  await waitFor(() =>
    expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenLastCalledWith('workspace', '', 200),
  );
});

test('large file previews report the total file size', async () => {
  render(<LocalFilesScreen />);
  fireEvent.press(await screen.findByText('README.md'));
  expect(
    await screen.findByText(/first 64\.0 KiB of 200\.0 KiB\. Files over 64 KiB cannot be edited/),
  ).toBeTruthy();
});

test('a missing workspace shows a typed message without calling native services', async () => {
  mockParams = {};
  render(<LocalFilesScreen />);
  expect(await screen.findByText('Choose a local workspace first.')).toBeTruthy();
  expect(mockRuntime.native.listWorkspaceFiles).not.toHaveBeenCalled();
  expect(mockRuntime.native.getWorkspaceChangeToken).not.toHaveBeenCalled();
});

test('agent edits that change the workspace token refresh the open listing', async () => {
  const view = render(<LocalFilesScreen />);
  await screen.findByText('README.md');
  await waitFor(() => expect(mockRuntime.native.getWorkspaceChangeToken).toHaveBeenCalled());
  expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenCalledTimes(1);
  mockVersion = 1;
  view.rerender(<LocalFilesScreen />);
  await act(async () => undefined);
  expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenCalledTimes(1);
  token = 'token-1';
  mockVersion = 2;
  view.rerender(<LocalFilesScreen />);
  await waitFor(() => expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenCalledTimes(2));
});

test('an opened file can be renamed and deleted from the Files UI', async () => {
  render(<LocalFilesScreen />);
  fireEvent.press(await screen.findByText('README.md'));
  fireEvent.changeText(await screen.findByLabelText('File path'), 'docs/README.md');
  fireEvent.press(screen.getByText('Rename file'));
  await waitFor(() =>
    expect(mockRuntime.native.renameWorkspaceEntry).toHaveBeenCalledWith(
      'workspace',
      'README.md',
      'docs/README.md',
    ),
  );
  await waitFor(() => expect(screen.queryByText('Rename file')).toBeNull());
  await waitFor(() => expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenCalledTimes(2));
  fireEvent.press(screen.getByText('README.md'));
  fireEvent.press(await screen.findByText('Delete file'));
  await waitFor(() =>
    expect(mockRuntime.native.removeWorkspaceEntry).toHaveBeenCalledWith('workspace', 'README.md'),
  );
  await waitFor(() => expect(mockRuntime.native.listWorkspaceFiles).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByText('Refresh files')).toBeEnabled());
});

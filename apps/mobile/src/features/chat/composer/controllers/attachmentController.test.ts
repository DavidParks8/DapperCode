import { requireTestValue } from '@shared/testing/requireTestValue';
import React from 'react';
import { Keyboard, Platform } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: jest.fn() },
  SaveFormat: { JPEG: 'jpeg' },
}));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentController,
  type PastedImage,
  addUniqueAttachmentPath,
  attachmentSizeError,
  retainFailedPreparedAttachment,
  useAttachmentController,
} from './attachmentController';

const documentPicker = DocumentPicker.getDocumentAsync as jest.Mock;
const getInfo = FileSystem.getInfoAsync as jest.Mock;
const deleteFile = FileSystem.deleteAsync as jest.Mock;
const manipulate = ImageManipulator.ImageManipulator.manipulate as jest.Mock;
const mediaPermission = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const cameraPermission = ImagePicker.requestCameraPermissionsAsync as jest.Mock;
const launchLibrary = ImagePicker.launchImageLibraryAsync as jest.Mock;
const launchCamera = ImagePicker.launchCameraAsync as jest.Mock;

function makeHarness(workspace: string | null = '/repo', draft = '', scopeKey?: string) {
  const api = {
    uploadAttachment: jest.fn().mockResolvedValue({ kind: 'file', path: '/repo/uploaded.txt' }),
  };
  const setError = jest.fn();
  let current: AttachmentController;
  function Probe(props: { workspace: string | null; draft: string; scopeKey?: string }) {
    current = useAttachmentController({
      api: api,
      chat: { id: 'thread-1' } as never,
      draft: props.draft,
      scopeKey: props.scopeKey,
      setError,
    });
    return null;
  }
  let tree: ReactTestRenderer;
  return {
    api,
    setError,
    get current() {
      return current!;
    },
    async mount(props = { workspace, draft, scopeKey }) {
      await act(async () => {
        tree = renderer.create(React.createElement(Probe, props));
      });
    },
    async update(props: { workspace: string | null; draft: string; scopeKey?: string }) {
      await act(async () => {
        tree!.update(React.createElement(Probe, props));
      });
    },
    unmount() {
      act(() => tree!.unmount());
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const pastedImage: PastedImage = {
  uri: 'file:///paste.png',
  width: 4000,
  height: 1000,
  fileName: 'paste.png',
  fileSize: 100,
  scopeKey: 'thread-1',
};

async function runAction(
  controller: AttachmentController,
  action: Parameters<AttachmentController['requestMenuAction']>[0],
) {
  act(() => controller.requestMenuAction(action));
  await act(async () => {
    jest.advanceTimersByTime(180);
    await Promise.resolve();
  });
}

describe('attachmentController', () => {
  it('normalizes and deduplicates attachment paths case-insensitively', () => {
    expect(addUniqueAttachmentPath(['/repo/File.ts'], ' /repo/file.ts ')).toEqual([
      '/repo/File.ts',
    ]);
    expect(addUniqueAttachmentPath([], ' /repo/new.ts ')).toEqual(['/repo/new.ts']);
  });

  it('rejects empty paths', () => {
    expect(addUniqueAttachmentPath([], '  ')).toBeNull();
  });

  it('rejects only files above the displayed attachment limit', () => {
    expect(attachmentSizeError(ATTACHMENT_MAX_BYTES)).toBeNull();
    expect(attachmentSizeError(ATTACHMENT_MAX_BYTES + 1)).toContain('20 MB');
  });

  it('retains prepared attachment metadata after an upload failure', () => {
    const prepared = {
      id: 'file:file:///cache/report.pdf',
      uri: 'file:///cache/report.pdf',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      kind: 'file' as const,
      sizeBytes: 1024,
      status: 'uploading' as const,
    };
    expect(retainFailedPreparedAttachment([prepared], prepared.id)).toEqual([
      { ...prepared, status: 'failed' },
    ]);
    expect(retainFailedPreparedAttachment([prepared], 'other')).toEqual([prepared]);
  });

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(globalThis, 'requestIdleCallback', {
      configurable: true,
      value: (callback: () => void) => {
        callback();
        return 1;
      },
    });
    Object.defineProperty(globalThis, 'cancelIdleCallback', {
      configurable: true,
      value: jest.fn(),
    });
    getInfo.mockReset().mockResolvedValue({ exists: true, isDirectory: false, size: 100 });
    deleteFile.mockReset().mockResolvedValue(undefined);
    documentPicker.mockReset().mockResolvedValue({ canceled: true, assets: [] });
    mediaPermission.mockReset().mockResolvedValue({ granted: true });
    cameraPermission.mockReset().mockResolvedValue({ granted: true });
    launchLibrary.mockReset().mockResolvedValue({ canceled: true, assets: [] });
    launchCamera.mockReset().mockResolvedValue({ canceled: true, assets: [] });
    const saveAsync = jest.fn().mockResolvedValue({ uri: 'file:///prepared.jpg' });
    const renderAsync = jest.fn().mockResolvedValue({ saveAsync });
    manipulate.mockReset().mockReturnValue({ resize: jest.fn(), renderAsync });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
  });

  it('dismisses the keyboard before opening the attachment menu', async () => {
    const harness = makeHarness();
    await harness.mount();
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);

    act(() => harness.current.openMenu());

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(harness.current.attachmentMenuVisible).toBe(true);
    harness.unmount();
  });

  it('blocks submission from native extraction through preparation and upload without picker UI', async () => {
    const harness = makeHarness();
    const source = deferred<{ exists: boolean; isDirectory: boolean; size: number }>();
    const uploaded = deferred<{ kind: string; path: string }>();
    getInfo.mockReturnValueOnce(source.promise);
    harness.api.uploadAttachment.mockReturnValueOnce(uploaded.promise);
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
    await harness.mount();
    act(() => harness.current.setPasteBusy({ busy: true, scopeKey: 'thread-1' }));
    expect(harness.current.pasteBusy).toBe(true);
    expect(harness.current.uploading).toBe(true);

    let paste!: Promise<void>;
    act(() => {
      paste = harness.current.pasteImage(pastedImage);
      harness.current.setPasteBusy({ busy: false, scopeKey: 'thread-1' });
    });
    expect(harness.current.pasteBusy).toBe(false);
    expect(harness.current.pickerBusy).toBe(true);
    expect(harness.current.uploading).toBe(true);
    expect(harness.current.composerAttachments).toEqual([]);
    expect(harness.current.toTurnInputs().localImages).toEqual([]);
    expect(deleteFile).not.toHaveBeenCalled();

    await act(async () => source.resolve({ exists: true, isDirectory: false, size: 100 }));
    expect(harness.current.uploading).toBe(true);
    expect(harness.current.pickerBusy).toBe(false);
    expect(harness.current.composerAttachments).toEqual([
      { id: 'prepared:image:file:///prepared.jpg', label: 'uploading · paste.jpg' },
    ]);
    expect(deleteFile).toHaveBeenCalledWith(pastedImage.uri, { idempotent: true });
    expect(manipulate.mock.results[0]?.value.resize).toHaveBeenCalledWith({ width: 2048 });
    expect(harness.api.uploadAttachment).toHaveBeenCalledWith({
      uri: 'file:///prepared.jpg',
      fileName: 'paste.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
      threadId: 'thread-1',
    });

    await act(async () => {
      uploaded.resolve({ kind: 'image', path: '/repo/paste.jpg' });
      await paste;
    });
    expect(harness.current.uploading).toBe(false);
    expect(harness.current.pickerBusy).toBe(false);
    expect(harness.current.hasFailedUploads).toBe(false);
    expect(harness.current.composerAttachments).toEqual([
      { id: 'image:/repo/paste.jpg', label: 'image · paste.jpg' },
    ]);
    expect(harness.current.toTurnInputs().localImages).toEqual([{ path: '/repo/paste.jpg' }]);
    expect(harness.current.attachmentMenuVisible).toBe(false);
    expect(harness.current.attachmentModalVisible).toBe(false);
    for (const interaction of [
      dismiss,
      documentPicker,
      launchLibrary,
      launchCamera,
      mediaPermission,
      cameraPermission,
    ]) {
      expect(interaction).not.toHaveBeenCalled();
    }
    expect(deleteFile).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it('retains the prepared paste for retry after deleting only the source', async () => {
    const harness = makeHarness();
    harness.api.uploadAttachment.mockRejectedValueOnce(new Error('offline'));
    await harness.mount();
    await act(async () => harness.current.pasteImage(pastedImage));
    expect(harness.current.uploading).toBe(false);
    expect(harness.current.pickerBusy).toBe(false);
    expect(harness.current.hasFailedUploads).toBe(true);
    expect(harness.current.composerAttachments[0]?.label).toBe('retry · paste.jpg');
    expect(harness.setError).toHaveBeenLastCalledWith('offline');
    const uploaded = deferred<{ kind: string; path: string }>();
    harness.api.uploadAttachment.mockReturnValueOnce(uploaded.promise);
    act(() => harness.current.retryFailedUploads());
    expect(harness.current.uploading).toBe(true);
    expect(harness.current.hasFailedUploads).toBe(false);
    await act(async () => uploaded.resolve({ kind: 'image', path: '/repo/retried.jpg' }));
    expect(harness.current.uploading).toBe(false);
    expect(harness.current.composerAttachments[0]?.label).toBe('image · retried.jpg');
    expect(harness.current.toTurnInputs().localImages).toEqual([{ path: '/repo/retried.jpg' }]);
    expect(harness.setError).toHaveBeenLastCalledWith(null);
    expect(manipulate).toHaveBeenCalledTimes(1);
    expect(deleteFile.mock.calls).toEqual([[pastedImage.uri, { idempotent: true }]]);
    expect(harness.api.uploadAttachment.mock.calls[1]).toEqual(
      harness.api.uploadAttachment.mock.calls[0],
    );
    harness.unmount();
  });

  it.each(['success', 'failure'] as const)(
    'does not resurrect a removed upload on %s',
    async (outcome) => {
      const harness = makeHarness();
      const uploaded = deferred<{ kind: string; path: string }>();
      harness.api.uploadAttachment.mockReturnValueOnce(uploaded.promise);
      await harness.mount();
      let paste!: Promise<void>;
      await act(async () => {
        paste = harness.current.pasteImage(pastedImage);
      });
      expect(harness.current.uploading).toBe(true);
      act(() => harness.current.removeComposerAttachment('prepared:image:file:///prepared.jpg'));
      expect(harness.current.uploading).toBe(false);
      harness.setError.mockClear();
      await act(async () => {
        if (outcome === 'success') {
          uploaded.resolve({ kind: 'image', path: '/repo/stale.jpg' });
        } else {
          uploaded.reject(new Error('stale failure'));
        }
        await paste;
      });
      expect(harness.current.composerAttachments).toEqual([]);
      expect(harness.current.toTurnInputs().localImages).toEqual([]);
      expect(harness.current.hasFailedUploads).toBe(false);
      expect(harness.setError).not.toHaveBeenCalled();
      harness.unmount();
    },
  );

  it.each(['preparing', 'uploading'] as const)(
    'fences scope navigation while %s and ignores stale native callbacks',
    async (phase) => {
      const harness = makeHarness('/repo', '', 'draft-a');
      const gate = deferred<never>();
      if (phase === 'preparing') {
        getInfo.mockReturnValueOnce(gate.promise);
      } else {
        harness.api.uploadAttachment.mockReturnValueOnce(gate.promise);
      }
      await harness.mount();
      const old = harness.current;
      let paste!: Promise<void>;
      await act(async () => {
        paste = old.pasteImage({ ...pastedImage, scopeKey: 'draft-a' });
      });
      expect(harness.current.uploading).toBe(true);
      await harness.update({ workspace: '/repo', draft: '', scopeKey: 'draft-b' });
      expect(harness.current.uploading).toBe(false);
      expect(harness.current.pickerBusy).toBe(false);
      expect(harness.current.pasteBusy).toBe(false);
      harness.setError.mockClear();
      await act(async () => {
        old.setPasteBusy({ busy: true, scopeKey: 'draft-a' });
        old.pasteError({ message: 'old native error', scopeKey: 'draft-a' });
        harness.current.setPasteBusy({ busy: true, scopeKey: 'draft-a' });
        harness.current.pasteError({ message: 'stale scope', scopeKey: 'draft-a' });
        await harness.current.pasteImage({
          ...pastedImage,
          uri: 'file:///stale.png',
          scopeKey: 'draft-a',
        });
        gate.reject(new Error('old async error'));
        await paste;
      });
      expect(deleteFile).toHaveBeenCalledWith('file:///stale.png', { idempotent: true });
      expect(deleteFile).toHaveBeenCalledWith(pastedImage.uri, { idempotent: true });
      expect(harness.current.uploading).toBe(false);
      expect(harness.current.composerAttachments).toEqual([]);
      expect(harness.current.toTurnInputs().localImages).toEqual([]);
      expect(harness.setError).not.toHaveBeenCalled();
      if (phase === 'preparing') {
        expect(harness.api.uploadAttachment).not.toHaveBeenCalled();
      }

      await harness.update({ workspace: '/repo', draft: '', scopeKey: 'draft-a' });
      await act(async () => old.pasteImage({ ...pastedImage, scopeKey: 'draft-a' }));
      expect(harness.current.uploading).toBe(false);
      expect(harness.current.composerAttachments).toEqual([]);
      harness.unmount();
    },
  );

  it.each(['clear', 'clearPending', 'unmount'] as const)(
    'cancels in-flight paste on %s',
    async (action) => {
      const harness = makeHarness();
      const uploaded = deferred<{ kind: string; path: string }>();
      harness.api.uploadAttachment.mockReturnValueOnce(uploaded.promise);
      await harness.mount();
      const old = harness.current;
      let paste!: Promise<void>;
      await act(async () => {
        paste = old.pasteImage(pastedImage);
      });
      if (action === 'unmount') {
        harness.unmount();
      } else {
        act(() => harness.current[action]());
      }
      harness.setError.mockClear();
      await act(async () => {
        old.setPasteBusy({ busy: true, scopeKey: 'thread-1' });
        old.pasteError({ message: 'late', scopeKey: 'thread-1' });
        await old.pasteImage({ ...pastedImage, uri: 'file:///late.png' });
        uploaded.resolve({ kind: 'image', path: '/repo/late.jpg' });
        await paste;
      });
      expect(harness.setError).not.toHaveBeenCalled();
      expect(deleteFile).toHaveBeenCalledWith('file:///late.png', { idempotent: true });
      if (action !== 'unmount') {
        expect(harness.current.uploading).toBe(false);
        expect(harness.current.pickerBusy).toBe(false);
        expect(harness.current.pasteBusy).toBe(false);
        expect(harness.current.composerAttachments).toEqual([]);
        expect(harness.current.toTurnInputs().localImages).toEqual([]);
        harness.unmount();
      }
    },
  );

  it.each(['source', 'prepared', 'unreadable'] as const)(
    'cleans up rejected %s pasted images and settles busy state',
    async (failure) => {
      const harness = makeHarness();
      await harness.mount();
      if (failure === 'prepared') {
        getInfo
          .mockResolvedValueOnce({ exists: true, isDirectory: false, size: 100 })
          .mockResolvedValueOnce({
            exists: true,
            isDirectory: false,
            size: ATTACHMENT_MAX_BYTES + 1,
          });
      } else if (failure === 'unreadable') {
        getInfo.mockResolvedValueOnce({ exists: false });
      }
      act(() => harness.current.setPasteBusy({ busy: true, scopeKey: 'thread-1' }));
      await act(async () => {
        const paste = harness.current.pasteImage({
          ...pastedImage,
          fileSize: failure === 'source' ? ATTACHMENT_MAX_BYTES + 1 : 100,
        });
        harness.current.setPasteBusy({ busy: false, scopeKey: 'thread-1' });
        await paste;
      });
      expect(harness.setError).toHaveBeenLastCalledWith(
        expect.stringContaining(failure === 'unreadable' ? 'Unable to read image' : '20 MB'),
      );
      expect(harness.current.uploading).toBe(false);
      expect(harness.current.pickerBusy).toBe(false);
      expect(harness.current.pasteBusy).toBe(false);
      expect(harness.current.hasFailedUploads).toBe(false);
      expect(harness.current.composerAttachments).toEqual([]);
      expect(harness.api.uploadAttachment).not.toHaveBeenCalled();
      expect(deleteFile.mock.calls).toEqual([[pastedImage.uri, { idempotent: true }]]);
      harness.unmount();
    },
  );

  it('reports native extraction errors and waits for the native busy end event', async () => {
    const harness = makeHarness();
    await harness.mount();
    act(() => {
      harness.current.setPasteBusy({ busy: true, scopeKey: 'thread-1' });
      harness.current.pasteError({ message: 'Cannot extract photo', scopeKey: 'thread-1' });
    });
    expect(harness.current.uploading).toBe(true);
    expect(harness.setError).toHaveBeenLastCalledWith('Cannot extract photo');
    act(() => harness.current.setPasteBusy({ busy: false, scopeKey: 'thread-1' }));
    expect(harness.current.uploading).toBe(false);
    harness.unmount();
  });

  it('keeps overlapping pastes busy and preserves each source until rendering finishes', async () => {
    const harness = makeHarness();
    const firstRender = deferred<{ saveAsync: jest.Mock }>();
    const secondRender = deferred<{ saveAsync: jest.Mock }>();
    manipulate
      .mockReturnValueOnce({ resize: jest.fn(), renderAsync: () => firstRender.promise })
      .mockReturnValueOnce({ resize: jest.fn(), renderAsync: () => secondRender.promise });
    harness.api.uploadAttachment
      .mockResolvedValueOnce({ kind: 'image', path: '/repo/first.jpg' })
      .mockResolvedValueOnce({ kind: 'image', path: '/repo/second.jpg' });
    await harness.mount();
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      harness.current.setPasteBusy({ busy: true, scopeKey: 'thread-1' });
      first = harness.current.pasteImage(pastedImage);
      second = harness.current.pasteImage({ ...pastedImage, uri: 'file:///second.png' });
      harness.current.setPasteBusy({ busy: false, scopeKey: 'thread-1' });
    });
    expect(deleteFile).not.toHaveBeenCalled();
    await act(async () => {
      firstRender.resolve({ saveAsync: jest.fn().mockResolvedValue({ uri: 'file:///first.jpg' }) });
      await first;
    });
    expect(deleteFile.mock.calls).toEqual([[pastedImage.uri, { idempotent: true }]]);
    expect(harness.current.uploading).toBe(true);
    expect(harness.current.pickerBusy).toBe(true);
    expect(harness.current.toTurnInputs().localImages).toEqual([{ path: '/repo/first.jpg' }]);
    await act(async () => {
      secondRender.resolve({
        saveAsync: jest.fn().mockResolvedValue({ uri: 'file:///second.jpg' }),
      });
      await second;
    });
    expect(harness.current.uploading).toBe(false);
    expect(harness.current.pickerBusy).toBe(false);
    expect(harness.current.toTurnInputs().localImages).toEqual([
      { path: '/repo/first.jpg' },
      { path: '/repo/second.jpg' },
    ]);
    harness.unmount();
  });

  it.each(['clear', 'unmount'] as const)(
    'discards a successfully prepared paste after %s',
    async (action) => {
      const harness = makeHarness();
      const rendered = deferred<{ saveAsync: jest.Mock }>();
      manipulate.mockReturnValueOnce({ resize: jest.fn(), renderAsync: () => rendered.promise });
      await harness.mount();
      let paste!: Promise<void>;
      await act(async () => {
        paste = harness.current.pasteImage(pastedImage);
      });
      if (action === 'clear') {
        act(() => harness.current.clear());
      } else {
        harness.unmount();
      }
      expect(deleteFile).not.toHaveBeenCalled();
      harness.setError.mockClear();
      await act(async () => {
        rendered.resolve({
          saveAsync: jest.fn().mockResolvedValue({ uri: 'file:///prepared.jpg' }),
        });
        await paste;
      });
      expect(deleteFile.mock.calls).toEqual([[pastedImage.uri, { idempotent: true }]]);
      expect(harness.api.uploadAttachment).not.toHaveBeenCalled();
      expect(harness.setError).not.toHaveBeenCalled();
      if (action === 'clear') {
        expect(harness.current.uploading).toBe(false);
        expect(harness.current.pickerBusy).toBe(false);
        expect(harness.current.composerAttachments).toEqual([]);
        harness.unmount();
      }
    },
  );

  it('blocks submission during picker preparation and ignores its result after navigation', async () => {
    const harness = makeHarness('/repo', '', 'draft-a');
    const rendered = deferred<{ saveAsync: jest.Mock }>();
    manipulate.mockReturnValueOnce({ resize: jest.fn(), renderAsync: () => rendered.promise });
    launchLibrary.mockResolvedValueOnce({ canceled: false, assets: [pastedImage] });
    await harness.mount();
    await runAction(harness.current, 'phone-image');
    expect(harness.current.uploading).toBe(true);
    expect(harness.current.pickerBusy).toBe(true);
    expect(harness.api.uploadAttachment).not.toHaveBeenCalled();
    await harness.update({ workspace: '/repo', draft: '', scopeKey: 'draft-b' });
    act(() => harness.current.setPasteBusy({ busy: true, scopeKey: 'draft-b' }));
    await act(async () => {
      rendered.resolve({ saveAsync: jest.fn().mockResolvedValue({ uri: 'file:///prepared.jpg' }) });
    });
    expect(harness.current.uploading).toBe(true);
    expect(harness.current.pasteBusy).toBe(true);
    expect(harness.current.pickerBusy).toBe(false);
    expect(harness.current.composerAttachments).toEqual([]);
    expect(harness.api.uploadAttachment).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('adds, deduplicates, removes, clears, and projects paths', async () => {
    const harness = makeHarness('/repo', '@a');
    await harness.mount();
    act(() => harness.current.submitPath());
    expect(harness.setError).toHaveBeenCalledWith('Enter a file path to attach');
    act(() => harness.current.setAttachmentPathDraft('/repo/a.ts'));
    act(() => harness.current.submitPath());
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/a.ts']);
    act(() => harness.current.setAttachmentPathDraft('/repo/A.ts'));
    act(() => harness.current.submitPath());
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/a.ts']);
    expect(harness.current.toTurnInputs('/repo').mentions).toHaveLength(1);
    act(() => harness.current.removeComposerAttachment('file:/repo/a.ts'));
    act(() => harness.current.removeComposerAttachment('unknown'));
    expect(harness.current.pendingMentionPaths).toEqual([]);
    act(() => harness.current.clearPending());
    act(() => harness.current.clear());
    harness.unmount();
  });

  it('picks files, rejects oversized files, uploads files, and retries failures', async () => {
    const harness = makeHarness();
    await harness.mount();
    documentPicker.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///large.pdf', name: 'large.pdf', size: ATTACHMENT_MAX_BYTES + 1 }],
    });
    await runAction(harness.current, 'phone-file');
    expect(harness.api.uploadAttachment).not.toHaveBeenCalled();

    documentPicker.mockResolvedValueOnce({ canceled: true, assets: [] });
    await runAction(harness.current, 'phone-file');

    documentPicker.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///report.pdf', name: 'report.pdf', mimeType: null }],
    });
    await runAction(harness.current, 'phone-file');
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/uploaded.txt']);

    harness.api.uploadAttachment.mockRejectedValueOnce(new Error('upload failed'));
    documentPicker.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///retry.pdf', name: 'retry.pdf', size: 100 }],
    });
    await runAction(harness.current, 'phone-file');
    expect(harness.current.hasFailedUploads).toBe(true);
    expect(harness.current.composerAttachments[0]?.label).toContain('retry');
    harness.api.uploadAttachment.mockResolvedValueOnce({ kind: 'file', path: '/repo/retried.pdf' });
    act(() => harness.current.retryFailedUploads());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.current.hasFailedUploads).toBe(false);
    harness.unmount();
  });

  it('prevents overlapping pickers and menu opening while picker work is active', async () => {
    let resolvePicker: (value: unknown) => void = () => undefined;
    documentPicker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePicker = resolve;
        }),
    );
    const harness = makeHarness();
    await harness.mount();
    act(() => harness.current.requestMenuAction('phone-file'));
    act(() => {
      jest.advanceTimersByTime(180);
    });
    expect(harness.current.pickerBusy).toBe(true);
    act(() => harness.current.openMenu());
    expect(harness.current.attachmentMenuVisible).toBe(false);
    act(() => harness.current.requestMenuAction('phone-file'));
    act(() => {
      jest.advanceTimersByTime(180);
    });
    expect(documentPicker).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePicker({ canceled: true, assets: [] });
      await Promise.resolve();
    });
    harness.unmount();
  });

  it('validates unreadable, empty, oversized, and malformed picker uploads', async () => {
    const harness = makeHarness();
    await harness.mount();
    for (const [uri, info] of [
      ['file:///missing', { exists: false, isDirectory: false, size: 1 }],
      ['file:///directory', { exists: true, isDirectory: true, size: 1 }],
      ['file:///empty', { exists: true, isDirectory: false, size: 0 }],
      ['file:///huge', { exists: true, isDirectory: false, size: ATTACHMENT_MAX_BYTES + 1 }],
    ] as const) {
      getInfo.mockResolvedValueOnce(info);
      documentPicker.mockResolvedValueOnce({ canceled: false, assets: [{ uri, name: 'file' }] });
      await runAction(harness.current, 'phone-file');
    }
    documentPicker.mockResolvedValueOnce({ canceled: false, assets: [{ uri: ' ', name: 'bad' }] });
    await runAction(harness.current, 'phone-file');
    documentPicker.mockRejectedValueOnce(new Error('picker failed'));
    await runAction(harness.current, 'phone-file');
    expect(harness.setError).toHaveBeenCalledWith('picker failed');
    harness.unmount();
  });

  it('picks and captures images across permissions, resize directions, and upload results', async () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const harness = makeHarness();
    await harness.mount();
    mediaPermission.mockResolvedValueOnce({ granted: false });
    await runAction(harness.current, 'phone-image');
    expect(launchLibrary).not.toHaveBeenCalled();

    launchLibrary.mockResolvedValueOnce({ canceled: true, assets: [] });
    await runAction(harness.current, 'phone-image');

    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: 'file:///wide.png', width: 4000, height: 1000, fileName: '.png', fileSize: 100 },
      ],
    });
    harness.api.uploadAttachment.mockResolvedValueOnce({ kind: 'image', path: '/repo/wide.jpg' });
    await runAction(harness.current, 'phone-image');
    expect(manipulate.mock.results.at(-1)?.value.resize).toHaveBeenCalledWith({ width: 2048 });
    expect(harness.current.pendingLocalImagePaths).toEqual(['/repo/wide.jpg']);

    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///small', width: 10, height: 10, fileName: null }],
    });
    harness.api.uploadAttachment.mockResolvedValueOnce({ kind: 'image', path: ' ' });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith('Image path is invalid');

    cameraPermission.mockResolvedValueOnce({ granted: false });
    await runAction(harness.current, 'phone-camera');
    launchCamera.mockResolvedValueOnce({ canceled: true, assets: [] });
    await runAction(harness.current, 'phone-camera');
    launchCamera.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tall.png', width: 1000, height: 4000, fileName: null }],
    });
    await runAction(harness.current, 'phone-camera');
    expect(manipulate.mock.results.at(-1)?.value.resize).toHaveBeenCalledWith({ height: 2048 });
    expect(harness.api.uploadAttachment).toHaveBeenLastCalledWith({
      uri: 'file:///prepared.jpg',
      fileName: 'camera-photo.jpg',
      mimeType: 'image/jpeg',
      threadId: 'thread-1',
      kind: 'image',
    });
    expect(harness.current.composerAttachments.some((entry) => entry.id.startsWith('image:'))).toBe(
      true,
    );
    act(() => harness.current.removeComposerAttachment('image:/repo/wide.jpg'));
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOs });
    harness.unmount();
  });

  it('validates source and rendered image sizes and rendered output', async () => {
    const harness = makeHarness();
    await harness.mount();
    const image = { canceled: false, assets: [{ uri: 'file:///image', width: 10, height: 10 }] };

    launchLibrary.mockResolvedValueOnce(image);
    getInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: ATTACHMENT_MAX_BYTES + 1,
    });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith(expect.stringContaining('20 MB'));

    launchLibrary.mockResolvedValueOnce(image);
    getInfo
      .mockResolvedValueOnce({ exists: true, isDirectory: false, size: 100 })
      .mockResolvedValueOnce({ exists: false, isDirectory: false, size: 100 });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith('Unable to prepare image');

    launchLibrary.mockResolvedValueOnce(image);
    getInfo
      .mockResolvedValueOnce({ exists: true, isDirectory: false, size: 100 })
      .mockResolvedValueOnce({ exists: true, isDirectory: false, size: ATTACHMENT_MAX_BYTES + 1 });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith(expect.stringContaining('Compressed image'));
    harness.unmount();
  });

  it('removes failed prepared uploads and uses a URI basename when no filename exists', async () => {
    const harness = makeHarness();
    harness.api.uploadAttachment.mockRejectedValueOnce(new Error('failed'));
    await harness.mount();
    documentPicker.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///unnamed.bin', name: undefined, size: 100 }],
    });
    await runAction(harness.current, 'phone-file');
    expect(harness.current.composerAttachments[0]?.label).toContain('unnamed.bin');
    act(() =>
      harness.current.removeComposerAttachment(
        requireTestValue(harness.current.composerAttachments[0], 'indexed test value').id,
      ),
    );
    expect(harness.current.composerAttachments).toEqual([]);
    harness.unmount();
  });

  it('handles image preparation failures and submission reconciliation', async () => {
    const harness = makeHarness('/repo', '@a.ts');
    await harness.mount();
    act(() => harness.current.setAttachmentPathDraft('/repo/a.ts'));
    act(() => harness.current.submitPath());
    act(() => harness.current.beginSubmission());
    await harness.update({ workspace: '/repo', draft: '' });
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/a.ts']);
    act(() => harness.current.finishSubmission(false, true));
    await harness.update({ workspace: '/repo', draft: 'restored' });
    expect(harness.current.pendingMentionPaths).toEqual(['/repo/a.ts']);
    await harness.update({ workspace: '/repo', draft: 'changed' });
    expect(harness.current.pendingMentionPaths).toEqual([]);
    act(() => harness.current.setAttachmentPathDraft('/repo/a.ts'));
    act(() => harness.current.submitPath());
    act(() => harness.current.finishSubmission(true));
    expect(harness.current.pendingMentionPaths).toEqual([]);

    launchLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///bad.png', width: 10, height: 10 }],
    });
    getInfo.mockResolvedValueOnce({ exists: false, isDirectory: false, size: 1 });
    await runAction(harness.current, 'phone-image');
    expect(harness.setError).toHaveBeenCalledWith('Unable to read image');
    harness.unmount();
  });
});

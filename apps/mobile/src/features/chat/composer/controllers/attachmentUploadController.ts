import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { Chat } from '@bridge/types/types';
import { normalizeAttachmentPath } from '../../helpers/helpers';

type AttachmentApi = Pick<HostBridgeApiClient, 'uploadAttachment'>;

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_LABEL = '20 MB';
const IMAGE_MAX_DIMENSION = 2048;
const IMAGE_COMPRESSION = 0.8;

export interface PastedImage {
  uri: string;
  width: number;
  height: number;
  fileName?: string;
  fileSize?: number;
  scopeKey: string;
}

export interface PreparedAttachment {
  id: string;
  uri: string;
  fileName?: string;
  mimeType?: string;
  kind: 'file' | 'image';
  sizeBytes: number;
  status: 'uploading' | 'failed';
}

export function attachmentSizeError(sizeBytes: number): string | null {
  return sizeBytes > ATTACHMENT_MAX_BYTES
    ? `Attachment exceeds the ${ATTACHMENT_MAX_LABEL} limit`
    : null;
}

export function retainFailedPreparedAttachment(
  attachments: PreparedAttachment[],
  id: string,
): PreparedAttachment[] {
  return attachments.map((attachment) =>
    attachment.id === id ? { ...attachment, status: 'failed' } : attachment,
  );
}

export function useAttachmentUploadController({
  api,
  chat,
  scopeKey,
  addImage,
  addMention,
  setError,
}: {
  api: AttachmentApi;
  chat: Chat | null;
  scopeKey: string;
  addImage: (rawPath: string) => boolean;
  addMention: (rawPath: string) => boolean;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pasteBusy, setNativePasteBusy] = useState(false);
  const [preparing, setPreparing] = useState(0);
  const [preparedAttachments, setPreparedAttachments] = useState<PreparedAttachment[]>([]);
  const pickerInProgressRef = useRef(false);
  const generationRef = useRef(0);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const uploadsRef = useRef(new Map<string, symbol>());
  const ownedImageUrisRef = useRef(new Set<string>());
  const discardPreparedImage = useCallback(async (uri: string) => {
    if (ownedImageUrisRef.current.delete(uri)) {
      await deleteTemporaryImage(uri);
    }
  }, []);
  const discardPreparedImages = useCallback(() => {
    for (const uri of ownedImageUrisRef.current) {
      void discardPreparedImage(uri);
    }
  }, [discardPreparedImage]);
  const generation = generationRef.current;
  const pasteScopeKey = JSON.stringify([scopeKey, generation]);
  const isCurrent = useCallback(
    () => generation === generationRef.current && scopeKey === scopeRef.current,
    [generation, scopeKey],
  );
  const clearUploads = useCallback(() => {
    generationRef.current += 1;
    discardPreparedImages();
    uploadsRef.current.clear();
    pickerInProgressRef.current = false;
    setPickerBusy(false);
    setNativePasteBusy(false);
    setPreparing(0);
    setPreparedAttachments([]);
  }, [discardPreparedImages]);

  useLayoutEffect(() => {
    return () => {
      generationRef.current += 1;
      discardPreparedImages();
    };
  }, [discardPreparedImages, scopeKey]);

  const removePreparedAttachment = useCallback(
    (id: string) => {
      uploadsRef.current.delete(id);
      if (id.startsWith('image:')) {
        void discardPreparedImage(id.slice('image:'.length));
      }
      setPreparedAttachments((current) => current.filter((entry) => entry.id !== id));
    },
    [discardPreparedImage],
  );
  const uploading =
    pickerBusy ||
    pasteBusy ||
    preparing > 0 ||
    preparedAttachments.some((attachment) => attachment.status === 'uploading');

  const upload = useCallback(
    async ({
      uri,
      fileName,
      mimeType,
      kind,
      knownSize,
      onPrepared,
      retry,
    }: {
      uri: string;
      fileName?: string;
      mimeType?: string;
      kind: 'file' | 'image';
      knownSize?: number;
      onPrepared?: () => void;
      retry?: boolean;
    }) => {
      const normalizedUri = normalizeAttachmentPath(uri);
      if (!normalizedUri) {
        setError('Unable to read attachment from this device');
        return;
      }
      const preparedId = `${kind}:${normalizedUri}`;
      const token = Symbol();
      uploadsRef.current.set(preparedId, token);
      const isActive = () => isCurrent() && uploadsRef.current.get(preparedId) === token;
      let preparedForRetry = retry === true;
      let retainForRetry = false;
      try {
        const info = await FileSystem.getInfoAsync(normalizedUri);
        if (!isActive()) {
          return;
        }
        if (!info.exists || info.isDirectory) {
          throw new Error('Unable to read attachment from this device');
        }
        const sizeBytes = knownSize ?? info.size;
        if (sizeBytes <= 0) {
          throw new Error('Attachment is empty');
        }
        const sizeError = attachmentSizeError(sizeBytes);
        if (sizeError) {
          throw new Error(sizeError);
        }
        const prepared: PreparedAttachment = {
          id: preparedId,
          uri: normalizedUri,
          fileName,
          mimeType,
          kind,
          sizeBytes,
          status: 'uploading',
        };
        setPreparedAttachments((current) => [
          ...current.filter((entry) => entry.id !== prepared.id),
          prepared,
        ]);
        preparedForRetry = true;
        onPrepared?.();
        const uploaded = await api.uploadAttachment({
          uri: normalizedUri,
          fileName,
          mimeType,
          threadId: chat?.id,
          kind,
        });
        if (!isActive()) {
          return;
        }
        if (uploaded.kind === 'image') {
          addImage(uploaded.path);
        } else {
          addMention(uploaded.path);
        }
        setPreparedAttachments((current) => current.filter((entry) => entry.id !== preparedId));
        uploadsRef.current.delete(preparedId);
      } catch (error) {
        if (!isActive()) {
          return;
        }
        uploadsRef.current.delete(preparedId);
        setPreparedAttachments((current) => retainFailedPreparedAttachment(current, preparedId));
        retainForRetry = preparedForRetry;
        setError((error as Error).message);
      } finally {
        if (!retainForRetry) {
          await discardPreparedImage(normalizedUri);
        }
      }
    },
    [addImage, addMention, api, chat?.id, discardPreparedImage, isCurrent, setError],
  );

  const retryFailedUploads = useCallback(() => {
    if (!isCurrent()) {
      return;
    }
    const failed = preparedAttachments.filter((attachment) => attachment.status === 'failed');
    setError(null);
    for (const attachment of failed) {
      if (uploadsRef.current.has(attachment.id)) {
        continue;
      }
      setPreparedAttachments((current) =>
        current.map((entry) =>
          entry.id === attachment.id ? { ...entry, status: 'uploading' } : entry,
        ),
      );
      void upload({
        uri: attachment.uri,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        knownSize: attachment.sizeBytes,
        retry: true,
      });
    }
  }, [isCurrent, preparedAttachments, setError, upload]);

  const prepareAndUploadImage = useCallback(
    async (image: Omit<PastedImage, 'scopeKey'>, pasted = false, onPrepared?: () => void) => {
      let prepared;
      try {
        try {
          if (!isCurrent()) {
            return;
          }
          prepared = await prepareImage(image.uri, image.width, image.height, image.fileSize);
        } finally {
          // Only native paste transfers ownership of its source temp file to us.
          if (pasted) {
            await deleteTemporaryImage(image.uri);
          }
        }
        ownedImageUrisRef.current.add(prepared.uri);
        if (!isCurrent()) {
          await discardPreparedImage(prepared.uri);
          return;
        }
        await upload({
          uri: prepared.uri,
          fileName: toJpegFileName(image.fileName ?? 'image.jpg'),
          mimeType: 'image/jpeg',
          kind: 'image',
          onPrepared,
        });
      } catch (error) {
        if (isCurrent()) {
          setError((error as Error).message);
        }
      }
    },
    [discardPreparedImage, isCurrent, setError, upload],
  );

  const pasteImage = useCallback(
    async (image: PastedImage, enabled = true): Promise<void> => {
      if (!enabled || !isCurrent() || image.scopeKey !== pasteScopeKey) {
        await deleteTemporaryImage(image.uri);
        return;
      }
      setPreparing((current) => current + 1);
      let preparing = true;
      const finishPreparing = () => {
        if (preparing && isCurrent()) {
          setPreparing((current) => current - 1);
        }
        preparing = false;
      };
      try {
        await prepareAndUploadImage(image, true, finishPreparing);
      } finally {
        finishPreparing();
      }
    },
    [isCurrent, prepareAndUploadImage, pasteScopeKey],
  );

  const setPasteBusy = useCallback(
    (event: { busy: boolean; scopeKey: string }) => {
      if (isCurrent() && event.scopeKey === pasteScopeKey) {
        if (event.busy) {
          setError(null);
        }
        setNativePasteBusy(event.busy);
      }
    },
    [isCurrent, pasteScopeKey, setError],
  );

  const pasteError = useCallback(
    (event: { message: string; scopeKey: string }) => {
      if (isCurrent() && event.scopeKey === pasteScopeKey) {
        setError(event.message);
      }
    },
    [isCurrent, pasteScopeKey, setError],
  );

  const runPicker = useCallback(
    async (picker: () => Promise<void>) => {
      if (!isCurrent() || pickerInProgressRef.current) {
        return;
      }
      pickerInProgressRef.current = true;
      setPickerBusy(true);
      setError(null);
      try {
        await picker();
      } catch (error) {
        if (isCurrent()) {
          setError((error as Error).message);
        }
      } finally {
        if (isCurrent()) {
          pickerInProgressRef.current = false;
          setPickerBusy(false);
        }
      }
    },
    [isCurrent, setError],
  );

  const pickFile = useCallback(
    () =>
      runPicker(async () => {
        const result = await DocumentPicker.getDocumentAsync({
          type: '*/*',
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (!isCurrent()) {
          return;
        }
        const file = result.canceled ? null : result.assets[0];
        if (file) {
          const sizeError = typeof file.size === 'number' ? attachmentSizeError(file.size) : null;
          if (sizeError) {
            setError(sizeError);
            return;
          }
          await upload({
            uri: file.uri,
            fileName: file.name,
            mimeType: file.mimeType ?? undefined,
            kind: 'file',
            knownSize: file.size,
          });
        }
      }),
    [isCurrent, runPicker, setError, upload],
  );

  const pickImage = useCallback(
    () =>
      runPicker(async () => {
        if (Platform.OS !== 'ios') {
          const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!isCurrent()) {
            return;
          }
          if (!permission.granted) {
            setError('Photo library permission is required to attach images');
            return;
          }
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 1,
          base64: false,
          allowsMultipleSelection: false,
        });
        if (!isCurrent()) {
          return;
        }
        const image = result.canceled ? null : result.assets[0];
        if (image) {
          await prepareAndUploadImage({ ...image, fileName: image.fileName ?? 'image.jpg' });
        }
      }),
    [isCurrent, prepareAndUploadImage, runPicker, setError],
  );

  const captureImage = useCallback(
    () =>
      runPicker(async () => {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!isCurrent()) {
          return;
        }
        if (!permission.granted) {
          setError('Camera permission is required to take a photo');
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 1,
          base64: false,
          allowsEditing: false,
        });
        if (!isCurrent()) {
          return;
        }
        const image = result.canceled ? null : result.assets[0];
        if (image) {
          await prepareAndUploadImage({ ...image, fileName: image.fileName ?? 'camera-photo.jpg' });
        }
      }),
    [isCurrent, prepareAndUploadImage, runPicker, setError],
  );

  return {
    captureImage,
    clearUploads,
    pasteImage,
    pasteBusy,
    pasteScopeKey,
    setPasteBusy,
    pasteError,
    pickerBusy: pickerBusy || preparing > 0,
    pickerInProgressRef,
    pickFile,
    pickImage,
    preparedAttachments,
    retryFailedUploads,
    removePreparedAttachment,
    uploading,
  };
}

async function prepareImage(uri: string, width: number, height: number, knownSize?: number) {
  const sourceInfo = await FileSystem.getInfoAsync(uri);
  if (!sourceInfo.exists || sourceInfo.isDirectory) {
    throw new Error('Unable to read image');
  }
  const sourceSizeError = attachmentSizeError(knownSize ?? sourceInfo.size);
  if (sourceSizeError) {
    throw new Error(sourceSizeError);
  }
  const longestSide = Math.max(width, height);
  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  if (longestSide > IMAGE_MAX_DIMENSION) {
    context.resize(
      width >= height ? { width: IMAGE_MAX_DIMENSION } : { height: IMAGE_MAX_DIMENSION },
    );
  }
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    compress: IMAGE_COMPRESSION,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  try {
    const info = await FileSystem.getInfoAsync(result.uri);
    if (!info.exists || info.isDirectory) {
      throw new Error('Unable to prepare image');
    }
    const sizeError = attachmentSizeError(info.size);
    if (sizeError) {
      throw new Error(`Compressed image still exceeds the ${ATTACHMENT_MAX_LABEL} limit`);
    }
    return result;
  } catch (error) {
    await deleteTemporaryImage(result.uri);
    throw error;
  }
}

async function deleteTemporaryImage(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    console.warn('Unable to remove temporary attachment image', error);
  }
}

function toJpegFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^./\\]+$/, '').trim() || 'image';
  return `${stem}.jpg`;
}

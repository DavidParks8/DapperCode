import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { Chat } from '@bridge/types/types';
import { normalizeAttachmentPath } from '../../helpers/helpers';

type AttachmentApi = Pick<HostBridgeApiClient, 'uploadAttachment'>;

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_LABEL = '20 MB';
const IMAGE_MAX_DIMENSION = 2048;
const IMAGE_COMPRESSION = 0.8;

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
  addImage,
  addMention,
  setError,
}: {
  api: AttachmentApi;
  chat: Chat | null;
  addImage: (rawPath: string) => boolean;
  addMention: (rawPath: string) => boolean;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const [pickerBusy, setPickerBusy] = useState(false);
  const [preparedAttachments, setPreparedAttachments] = useState<PreparedAttachment[]>([]);
  const pickerInProgressRef = useRef(false);
  const uploading = preparedAttachments.some((attachment) => attachment.status === 'uploading');

  const upload = useCallback(
    async ({
      uri,
      fileName,
      mimeType,
      kind,
      knownSize,
    }: {
      uri: string;
      fileName?: string;
      mimeType?: string;
      kind: 'file' | 'image';
      knownSize?: number;
    }) => {
      const normalizedUri = normalizeAttachmentPath(uri);
      if (!normalizedUri) {
        setError('Unable to read attachment from this device');
        return;
      }
      let preparedId: string | null = null;
      try {
        const info = await FileSystem.getInfoAsync(normalizedUri);
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
        preparedId = `${kind}:${normalizedUri}`;
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
        const uploaded = await api.uploadAttachment({
          uri: normalizedUri,
          fileName,
          mimeType,
          threadId: chat?.id,
          kind,
        });
        if (uploaded.kind === 'image') {
          addImage(uploaded.path);
        } else {
          addMention(uploaded.path);
        }
        setPreparedAttachments((current) => current.filter((entry) => entry.id !== preparedId));
        setError(null);
      } catch (error) {
        const failedId = preparedId;
        if (failedId) {
          setPreparedAttachments((current) => retainFailedPreparedAttachment(current, failedId));
        }
        setError((error as Error).message);
      }
    },
    [addImage, addMention, api, chat?.id, setError],
  );

  const retryFailedUploads = useCallback(() => {
    const failed = preparedAttachments.filter((attachment) => attachment.status === 'failed');
    for (const attachment of failed) {
      void upload({
        uri: attachment.uri,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        knownSize: attachment.sizeBytes,
      });
    }
  }, [preparedAttachments, upload]);

  const runPicker = useCallback(
    async (picker: () => Promise<void>) => {
      if (pickerInProgressRef.current) {
        return;
      }
      pickerInProgressRef.current = true;
      setPickerBusy(true);
      try {
        await picker();
      } catch (error) {
        setError((error as Error).message);
      } finally {
        pickerInProgressRef.current = false;
        setPickerBusy(false);
      }
    },
    [setError],
  );

  const pickFile = useCallback(
    () =>
      runPicker(async () => {
        const result = await DocumentPicker.getDocumentAsync({
          type: '*/*',
          copyToCacheDirectory: true,
          multiple: false,
        });
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
    [runPicker, setError, upload],
  );

  const pickImage = useCallback(
    () =>
      runPicker(async () => {
        if (Platform.OS !== 'ios') {
          const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
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
        const image = result.canceled ? null : result.assets[0];
        if (image) {
          const prepared = await prepareImage(image.uri, image.width, image.height, image.fileSize);
          await upload({
            uri: prepared.uri,
            fileName: toJpegFileName(image.fileName ?? 'image.jpg'),
            mimeType: 'image/jpeg',
            kind: 'image',
          });
        }
      }),
    [runPicker, setError, upload],
  );

  const captureImage = useCallback(
    () =>
      runPicker(async () => {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
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
        const image = result.canceled ? null : result.assets[0];
        if (image) {
          const prepared = await prepareImage(image.uri, image.width, image.height, image.fileSize);
          await upload({
            uri: prepared.uri,
            fileName: toJpegFileName(image.fileName ?? 'camera-photo.jpg'),
            mimeType: 'image/jpeg',
            kind: 'image',
          });
        }
      }),
    [runPicker, setError, upload],
  );

  return {
    captureImage,
    pickerBusy,
    pickerInProgressRef,
    pickFile,
    pickImage,
    preparedAttachments,
    retryFailedUploads,
    setPreparedAttachments,
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
  const info = await FileSystem.getInfoAsync(result.uri);
  if (!info.exists || info.isDirectory) {
    throw new Error('Unable to prepare image');
  }
  const sizeError = attachmentSizeError(info.size);
  if (sizeError) {
    throw new Error(`Compressed image still exceeds the ${ATTACHMENT_MAX_LABEL} limit`);
  }
  return result;
}

function toJpegFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^./\\]+$/, '').trim() || 'image';
  return `${stem}.jpg`;
}

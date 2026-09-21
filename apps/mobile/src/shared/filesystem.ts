import type { Directory, File, FileInfo } from 'expo-file-system';

// Keep I/O behind the async boundary used by persistence queues and attachment cancellation.
export function readFileInfo(file: File): Promise<FileInfo> {
  return new Promise((resolve) => resolve(file.info()));
}

export function writeFile(file: File, value: string): Promise<void> {
  return new Promise((resolve) => resolve(file.write(value)));
}

export function ensureDirectory(directory: Directory): Promise<void> {
  return new Promise((resolve) =>
    resolve(directory.create({ intermediates: true, idempotent: true })),
  );
}

export function deleteFileIfPresent(file: File): Promise<void> {
  return new Promise((resolve) => resolve(file.exists ? file.delete() : undefined));
}

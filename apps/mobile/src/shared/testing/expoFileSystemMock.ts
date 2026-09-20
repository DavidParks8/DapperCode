import type { DirectoryCreateOptions, FileInfo, PathInfo } from 'expo-file-system';

// Deferred hooks let persistence tests exercise pending I/O and purge ordering.
export const fileSystemMock = {
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  read: jest.fn<Promise<string>, [string]>(),
  write: jest.fn<Promise<void>, [string, string]>(),
  createDirectory: jest.fn<Promise<void>, [string, DirectoryCreateOptions?]>(),
  deleteFile: jest.fn<Promise<void>, [string]>(),
  info: jest.fn<Promise<FileInfo & { isDirectory?: boolean }>, [string]>(),
  pathInfo: jest.fn<PathInfo, [string]>(),
  exists: jest.fn<boolean, [string]>(),
};

export function resetFileSystemMock() {
  fileSystemMock.documentDirectory = 'file:///documents/';
  fileSystemMock.cacheDirectory = 'file:///cache/';
  fileSystemMock.read.mockReset().mockRejectedValue(new Error('missing'));
  fileSystemMock.write.mockReset().mockResolvedValue(undefined);
  fileSystemMock.createDirectory.mockReset().mockResolvedValue(undefined);
  fileSystemMock.deleteFile.mockReset().mockResolvedValue(undefined);
  fileSystemMock.info.mockReset().mockResolvedValue({ exists: true, size: 100 });
  fileSystemMock.pathInfo.mockReset().mockReturnValue({ exists: true, isDirectory: false });
  fileSystemMock.exists.mockReset().mockReturnValue(true);
}

function join(parts: (string | { uri: string })[]): string {
  return parts
    .map((part, index) => {
      const value = typeof part === 'string' ? part : part.uri;
      const encoded = index === 0 ? value : encodeURI(value).replace(/[?#]/g, encodeURIComponent);
      return encoded.replace(/\/+$/, '');
    })
    .join('/');
}

export class File {
  readonly uri: string;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = join(parts);
  }
  get parentDirectory() {
    return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/')));
  }
  get exists() {
    return fileSystemMock.exists(this.uri);
  }
  text() {
    return fileSystemMock.read(this.uri);
  }
  write(value: string) {
    return fileSystemMock.write(this.uri, value);
  }
  delete() {
    return fileSystemMock.deleteFile(this.uri);
  }
  async info() {
    const info = await fileSystemMock.info(this.uri);
    if (info.isDirectory) {
      return { exists: false, uri: this.uri };
    }
    return info;
  }
}

export class Directory {
  readonly uri: string;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = `${join(parts)}/`;
  }
  create(options?: DirectoryCreateOptions) {
    return fileSystemMock.createDirectory(this.uri, options);
  }
}

export const Paths = {
  info(uri: string) {
    return fileSystemMock.pathInfo(uri);
  },
  get document() {
    return new Directory(fileSystemMock.documentDirectory);
  },
  get cache() {
    return new Directory(fileSystemMock.cacheDirectory);
  },
};

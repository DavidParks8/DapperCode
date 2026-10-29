export interface LocalWorkspace {
  id: string;
  name: string;
}

export interface LocalFileRead {
  path: string;
  content: string;
  revision: string;
  nextOffset: number | null;
}

export interface LocalDirectoryListing {
  entries: {
    name: string;
    kind: 'file' | 'directory' | 'symlink' | 'other';
    bytes: number;
  }[];
  truncated: boolean;
}

export interface LocalSearchResult {
  matches: { path: string; line: number; content: string }[];
  truncated: boolean;
  skippedFiles: number;
  visitedEntries: number;
  searchedBytes: number;
}

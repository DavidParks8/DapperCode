import { isRecord } from '@shared/records';
import type { GitAccount } from '../auth/strategy';
import type { LocalGitIdentity } from '../git/gitTools';

export interface LocalPreferences {
  version: 1;
  workspaceId: string | null;
  modelId: string | null;
  account: GitAccount | null;
  author: LocalGitIdentity | null;
  drafts: Record<string, string>;
}

export function emptyLocalPreferences(): LocalPreferences {
  return { version: 1, workspaceId: null, modelId: null, account: null, author: null, drafts: {} };
}

function nullable(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !value) {
    throw new Error('Local preference text is invalid.');
  }
  return value;
}

function account(value: unknown): GitAccount | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || value['providerId'] !== 'github' || value['host'] !== 'github.com') {
    throw new Error('Local Git account data is invalid.');
  }
  const id = nullable(value['id']);
  const login = nullable(value['login']);
  const credentialRef = nullable(value['credentialRef']);
  if (!id || !login || !credentialRef) {
    throw new Error('Local Git account data is incomplete.');
  }
  return { providerId: 'github', host: 'github.com', id, login, credentialRef };
}

function author(value: unknown): LocalGitIdentity | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value['name'] !== 'string' || typeof value['email'] !== 'string') {
    throw new Error('Local Git author data is invalid.');
  }
  return { name: value['name'], email: value['email'] };
}

export function parseLocalPreferences(raw: string | null): LocalPreferences {
  if (raw === null) {
    return emptyLocalPreferences();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Local preferences are damaged. Their data has been preserved.');
    }
    throw error;
  }
  if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['drafts'])) {
    throw new Error('Local preferences have an unsupported format.');
  }
  const drafts: Record<string, string> = {};
  for (const [key, draft] of Object.entries(value['drafts'])) {
    if (typeof draft !== 'string') {
      throw new Error('A local draft is invalid.');
    }
    drafts[key] = draft;
  }
  return {
    version: 1,
    workspaceId: nullable(value['workspaceId']),
    modelId: nullable(value['modelId']),
    account: account(value['account']),
    author: author(value['author']),
    drafts,
  };
}

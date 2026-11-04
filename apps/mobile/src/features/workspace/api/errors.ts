/**
 * Friendly copy for typed host failures. The in-process host reports native failure codes as
 * `data.nativeCode` and stable reasons as `data.error` on JSON-RPC errors; anything unrecognised
 * keeps its own message, which hosts already phrase for people.
 */
const NATIVE_CODE_COPY: Record<string, string> = {
  WORKSPACE_NAME_INVALID: 'Use a name with letters, numbers, spaces, dots, dashes, or underscores.',
  WORKSPACE_NOT_FOUND: 'That workspace is no longer on this device.',
  PATH_EXISTS: 'Something with that name already exists here.',
  PATH_NOT_FOUND: 'That file or folder no longer exists. Refresh to see the current files.',
  PATH_OUTSIDE_WORKSPACE: 'That path is outside the workspace.',
  PATH_UNSUPPORTED: 'This kind of item cannot be changed here.',
  FILE_REVISION_CONFLICT: 'The file changed since you opened it.',
  FILE_NOT_TEXT: "This file isn't text, so it can't be shown here.",
  FILE_TOO_LARGE: 'This file is too large to save here.',
  GIT_NOT_REPOSITORY: "This workspace doesn't use Git yet.",
  GIT_ALREADY_REPOSITORY: 'This workspace already uses Git.',
  GIT_NO_ORIGIN: 'Add a remote named origin to push, fetch, or pull.',
  GIT_NO_UPSTREAM: 'This branch has no upstream yet. Push it first.',
  GIT_NO_COMMITS: 'Make a first commit before doing that.',
  GIT_DETACHED_HEAD: 'Switch to a branch first.',
  GIT_NOTHING_TO_COMMIT: 'Stage changes before committing.',
  GIT_DIRTY_WORKTREE: 'Commit or discard your changes before switching branches.',
  GIT_BRANCH_INVALID: 'That is not a valid branch name.',
  GIT_BRANCH_EXISTS: 'A branch with that name already exists.',
  GIT_BRANCH_NOT_FOUND: 'That branch no longer exists. Refresh and try again.',
  GIT_NON_FAST_FORWARD:
    'Your branch and its upstream have diverged. Pull only fast-forwards, so push or reset your local commits on a computer.',
  GIT_CONFLICT: 'Pulling would overwrite local changes. Commit or discard them first.',
  GIT_LOCKED: 'Another Git operation is running. Try again in a moment.',
  GIT_INSECURE_REMOTE: 'Only HTTPS remotes are supported.',
  GIT_CREDENTIAL_ORIGIN: "Your GitHub sign-in can't be used with this remote.",
  GIT_AUTH_FAILED: 'The remote rejected your credentials. Sign in to GitHub in Settings.',
  GIT_CERTIFICATE: "The remote's certificate could not be verified.",
  GIT_REMOTE_REJECTED: 'The remote rejected the push. Pull first, or check your permissions.',
  GIT_NETWORK: "Couldn't reach the remote. Check your connection and try again.",
  GIT_TRANSFER_BUSY: 'Another clone, fetch, pull, or push is running.',
  GIT_TRANSFER_INTERRUPTED: 'The transfer was cancelled.',
  CREDENTIAL_UNAVAILABLE: 'Sign in to GitHub in Settings to use private repositories.',
  CREDENTIAL_INVALID: 'Your GitHub sign-in expired. Sign in again in Settings.',
};

function errorData(error: unknown): Record<string, unknown> {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      return data as Record<string, unknown>;
    }
  }
  return {};
}

/** Stable reason (`data.error`) of a host failure, such as `on_device_not_repository`. */
export function hostErrorReason(error: unknown): string | null {
  const reason = errorData(error)['error'];
  return typeof reason === 'string' ? reason : null;
}

export function hostErrorNativeCode(error: unknown): string | null {
  const code = errorData(error)['nativeCode'];
  return typeof code === 'string' ? code : null;
}

/** Whether a Git read failed because the workspace has no repository. */
export function isNotRepositoryError(error: unknown): boolean {
  return (
    hostErrorReason(error) === 'on_device_not_repository' ||
    hostErrorNativeCode(error) === 'GIT_NOT_REPOSITORY'
  );
}

export function describeHostError(error: unknown, fallback: string): string {
  const code = hostErrorNativeCode(error);
  const copy = code ? NATIVE_CODE_COPY[code] : undefined;
  if (copy) {
    return copy;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

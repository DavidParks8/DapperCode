/**
 * Validation for HTTPS Git remotes, shared by the clone and init forms and the hosts that run them.
 * Returns user-facing copy, or null when the URL is acceptable.
 */
export function httpsRemoteError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Paste a repository URL.';
  }
  if (/^[\w.-]+@[\w.-]+:/u.test(trimmed) || trimmed.startsWith('ssh://')) {
    return 'Use the HTTPS URL. SSH remotes are not supported on this device.';
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a full URL such as https://github.com/owner/repository.git.';
  }
  if (url.protocol !== 'https:') {
    return 'Use an https:// URL.';
  }
  if (!url.hostname || url.pathname.replace(/\/+$/u, '').length <= 1) {
    return 'Include the repository path, such as https://github.com/owner/repository.git.';
  }
  if (url.username || url.password) {
    return 'Remove the user name or token from the URL. Sign in to GitHub in Settings instead.';
  }
  return null;
}

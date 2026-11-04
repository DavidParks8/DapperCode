/**
 * Stable failure codes reported by the native on-device module (see
 * `modules/on-device-agent/ios/NativeServiceError.swift`). `NATIVE_FAILURE` covers errors that the
 * native layer did not classify.
 */
export const ON_DEVICE_NATIVE_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'WORKSPACE_REQUIRED',
  'WORKSPACE_INVALID_ID',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_NAME_INVALID',
  'WORKSPACE_CORRUPT',
  'PATH_OUTSIDE_WORKSPACE',
  'PATH_NOT_FOUND',
  'PATH_EXISTS',
  'PATH_NOT_DIRECTORY',
  'PATH_UNSUPPORTED',
  'FILE_REVISION_CONFLICT',
  'FILE_NOT_TEXT',
  'FILE_TOO_LARGE',
  'EDIT_NO_UNIQUE_MATCH',
  'STORAGE_FAILURE',
  'CREDENTIAL_INVALID',
  'CREDENTIAL_UNAVAILABLE',
  'GIT_NOT_REPOSITORY',
  'GIT_ALREADY_REPOSITORY',
  'GIT_NO_ORIGIN',
  'GIT_NO_UPSTREAM',
  'GIT_NO_COMMITS',
  'GIT_DETACHED_HEAD',
  'GIT_NOTHING_TO_COMMIT',
  'GIT_DIRTY_WORKTREE',
  'GIT_BRANCH_INVALID',
  'GIT_BRANCH_EXISTS',
  'GIT_BRANCH_NOT_FOUND',
  'GIT_NON_FAST_FORWARD',
  'GIT_CONFLICT',
  'GIT_LOCKED',
  'GIT_INSECURE_REMOTE',
  'GIT_CREDENTIAL_ORIGIN',
  'GIT_AUTH_FAILED',
  'GIT_CERTIFICATE',
  'GIT_REMOTE_REJECTED',
  'GIT_NETWORK',
  'GIT_TRANSFER_BUSY',
  'GIT_TRANSFER_INTERRUPTED',
  'GIT_FAILURE',
  'NATIVE_FAILURE',
] as const;

export type OnDeviceNativeErrorCode = (typeof ON_DEVICE_NATIVE_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(ON_DEVICE_NATIVE_ERROR_CODES);
const TAG = /\[ondevice:([A-Z_]+)\]\s*/;
const EXCEPTION_PREFIX = /^(?:Error:\s*)?(?:[A-Za-z]+Exception:\s*)+/;
const SOURCE_SUFFIX = /\s*\(at [^()]*:\d+\)\s*$/;
const CAUSE_SEPARATOR = '\n→ Caused by: ';

/** A user-presentable native failure with a stable `code`. */
export class OnDeviceNativeError extends Error {
  readonly code: OnDeviceNativeErrorCode;

  constructor(code: OnDeviceNativeErrorCode, message: string) {
    super(message);
    this.name = 'OnDeviceNativeError';
    this.code = code;
  }
}

export function isOnDeviceNativeError(
  error: unknown,
  code?: OnDeviceNativeErrorCode,
): error is OnDeviceNativeError {
  return error instanceof OnDeviceNativeError && (code === undefined || error.code === code);
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : '';
}

/**
 * Converts an Expo-wrapped native rejection (for example
 * `UnexpectedException: [ondevice:PATH_NOT_FOUND] … (at ExpoModulesCore/…swift:90)`) into a typed
 * error whose message never contains native exception names or source coordinates.
 */
export function toOnDeviceNativeError(error: unknown): OnDeviceNativeError {
  if (error instanceof OnDeviceNativeError) {
    return error;
  }
  const message = rawMessage(error);
  const tagged = TAG.exec(message);
  let code: OnDeviceNativeErrorCode = 'NATIVE_FAILURE';
  let detail = message;
  if (tagged) {
    const candidate = tagged[1] ?? '';
    code = KNOWN_CODES.has(candidate) ? (candidate as OnDeviceNativeErrorCode) : 'NATIVE_FAILURE';
    detail = message.slice(tagged.index + tagged[0].length).split(CAUSE_SEPARATOR)[0] ?? '';
  } else if (detail.includes(CAUSE_SEPARATOR)) {
    // Expo chains wrapper exceptions; the innermost cause carries the actual reason.
    detail = detail.slice(detail.lastIndexOf(CAUSE_SEPARATOR) + CAUSE_SEPARATOR.length);
  }
  detail = detail.replace(EXCEPTION_PREFIX, '').replace(SOURCE_SUFFIX, '').trim();
  return new OnDeviceNativeError(code, detail || 'The on-device operation failed.');
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Wraps every native function so synchronous throws and promise rejections surface as
 * `OnDeviceNativeError`. Non-function members pass through unchanged.
 */
export function withNativeErrorMapping<T extends object>(native: T): T {
  const wrappers = new Map<PropertyKey, unknown>();
  return new Proxy(native, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') {
        return value;
      }
      const cached = wrappers.get(property);
      if (cached) {
        return cached;
      }
      const wrapper = (...args: unknown[]) => {
        let result: unknown;
        try {
          result = (value as (...values: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          throw toOnDeviceNativeError(error);
        }
        return isThenable(result)
          ? Promise.resolve(result).catch((error: unknown) => {
              throw toOnDeviceNativeError(error);
            })
          : result;
      };
      wrappers.set(property, wrapper);
      return wrapper;
    },
  });
}

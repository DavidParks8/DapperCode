import { describeHostError, isNotRepositoryError } from './errors';
import { httpsRemoteError } from './remoteUrl';

describe('httpsRemoteError', () => {
  it('accepts HTTPS repository URLs', () => {
    expect(httpsRemoteError('https://github.com/acme/demo.git')).toBeNull();
    expect(httpsRemoteError(' https://gitlab.com/group/sub/repo ')).toBeNull();
  });

  it.each([
    ['', /Paste/u],
    ['git@github.com:acme/demo.git', /HTTPS URL/u],
    ['ssh://git@github.com/acme/demo.git', /HTTPS URL/u],
    ['http://github.com/acme/demo.git', /https:\/\//u],
    ['github.com/acme/demo', /full URL/u],
    ['https://github.com/', /repository path/u],
    ['https://user:token@github.com/acme/demo.git', /token/u],
  ])('rejects %j with guidance instead of a raw parser error', (value, message) => {
    const error = httpsRemoteError(value);
    expect(error).toMatch(message);
    expect(error).not.toMatch(/Invalid URL/u);
  });
});

describe('describeHostError', () => {
  it('maps typed native codes to friendly copy and keeps other messages', () => {
    const typed = Object.assign(new Error('raw'), {
      data: { error: 'on_device_failed', nativeCode: 'GIT_CONFLICT' },
    });
    expect(describeHostError(typed, 'fallback')).toMatch(/overwrite local changes/u);
    expect(describeHostError(new Error('Bridge said no'), 'fallback')).toBe('Bridge said no');
    expect(describeHostError(null, 'fallback')).toBe('fallback');
  });

  it('recognises not-repository failures by reason or native code', () => {
    expect(isNotRepositoryError({ data: { error: 'on_device_not_repository' } })).toBe(true);
    expect(isNotRepositoryError({ data: { nativeCode: 'GIT_NOT_REPOSITORY' } })).toBe(true);
    expect(isNotRepositoryError(new Error('nope'))).toBe(false);
  });
});

import type { GitRemoteState } from '../../workspace/api/protocol';
import {
  deriveUpstreamState,
  gitFetchBlockedReason,
  gitPullBlockedReason,
  gitPushBlockedReason,
} from './derived';

const remote: GitRemoteState = {
  hasOrigin: true,
  origin: 'https://github.com/acme/demo.git',
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  detached: false,
  unborn: false,
  network: 'online',
};

describe('Git remote gating', () => {
  it('keeps bridge behaviour when the host reports no remote state', () => {
    expect(gitPushBlockedReason(null)).toBeNull();
    expect(gitFetchBlockedReason(null)).toBeNull();
    expect(gitPullBlockedReason(null)).toBeNull();
    expect(
      deriveUpstreamState({
        branch: 'main',
        clean: true,
        raw: '## main...origin/main [ahead 3, behind 2]',
        files: [],
        truncated: false,
        totalFiles: 0,
        omittedFiles: 0,
        maxFiles: 1,
        maxBytes: 1,
      }),
    ).toEqual({
      remote: null,
      aheadCount: 3,
      behindCount: 2,
      hasUpstream: true,
      upstreamBranch: 'origin/main',
    });
  });

  it('explains every reason push, fetch, and pull are unavailable', () => {
    expect(gitPushBlockedReason({ ...remote, hasOrigin: false })).toMatch(/no origin remote/u);
    expect(gitPushBlockedReason({ ...remote, unborn: true })).toMatch(/first commit/u);
    expect(gitPushBlockedReason({ ...remote, detached: true })).toMatch(/Switch to a branch/u);
    expect(gitPushBlockedReason({ ...remote, network: 'offline' })).toMatch(/offline/u);
    expect(gitPushBlockedReason(remote)).toBeNull();
    expect(gitFetchBlockedReason({ ...remote, hasOrigin: false })).toMatch(/origin/u);
    expect(gitFetchBlockedReason({ ...remote, network: 'offline' })).toMatch(/offline/u);
    expect(gitPullBlockedReason({ ...remote, upstream: null })).toMatch(/no upstream/u);
    expect(gitPullBlockedReason(remote)).toBeNull();
  });
});

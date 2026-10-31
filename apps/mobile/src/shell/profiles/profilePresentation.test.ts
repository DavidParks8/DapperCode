import type { BridgeProfile } from '@shell/state/bridgeProfiles';
import { LOCAL_PROFILE } from '@shell/state/localProfile';
import type { LocalSetupState } from './localSetup';
import {
  bridgeHost,
  describeProfile,
  installedAgentsFooter,
  profileSummary,
  profilesFooter,
} from './profilePresentation';

const bridge: BridgeProfile = {
  id: 'bridge-1',
  name: 'Desk',
  bridgeUrl: 'https://user:secret@desk.local:8787/rpc?token=x',
  bridgeToken: 'token',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const needsModel: LocalSetupState = {
  readiness: { canStart: false, reason: 'Choose a model.', action: 'choose-model' },
  model: 'todo',
  workspace: 'todo',
  author: 'recommended',
  chatStarted: false,
  summary: 'Needs a model',
};

describe('profile presentation', () => {
  it('names a bridge by host without credentials, path, or query', () => {
    expect(bridgeHost(bridge.bridgeUrl)).toBe('desk.local:8787');
    expect(bridgeHost('192.168.1.4:3001')).toBe('192.168.1.4:3001');
  });

  it('reports connection only for the open bridge', () => {
    const context = { bridgeConnected: false, localSetup: null };
    expect(describeProfile(bridge, { ...context, active: true })).toEqual({
      icon: 'desktop-outline',
      detail: 'desk.local:8787',
      status: 'Disconnected',
    });
    expect(describeProfile(bridge, { ...context, active: false }).status).toBeNull();
  });

  it('reports setup progress, never "Offline", for the open local profile', () => {
    const open = describeProfile(LOCAL_PROFILE, {
      active: true,
      bridgeConnected: false,
      localSetup: needsModel,
    });
    expect(open).toEqual({
      icon: 'phone-portrait-outline',
      detail: 'Private offline models',
      status: 'Needs a model',
    });
    expect(profileSummary(open)).toBe('Needs a model · Private offline models');
    const closed = describeProfile(LOCAL_PROFILE, {
      active: false,
      bridgeConnected: true,
      localSetup: null,
    });
    expect(profileSummary(closed)).toBe('Private offline models');
  });

  it('explains where agents are installed for each kind of profile', () => {
    expect(installedAgentsFooter(bridge)).toBe(
      'Agents are installed and registered on the desktop host.',
    );
    expect(installedAgentsFooter(LOCAL_PROFILE)).not.toMatch(/desktop/);
    expect(profilesFooter([bridge])).toBe('Switching profiles opens a new chat there.');
    expect(profilesFooter([bridge, LOCAL_PROFILE])).toMatch(/On this iPhone runs private models/);
  });
});

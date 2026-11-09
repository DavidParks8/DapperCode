import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { fetch } from 'expo/fetch';
import { AccessibilityInfo, Alert, ScrollView } from 'react-native';

import { router } from 'expo-router';
import { resetRouterMock } from '@shared/testing/expoRouterMock';
import { routes } from '@shell/navigation/routes';
import { PREFERENCES_DOCUMENT } from '../../on-device/runtime/preferences';
import type { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import { LocalSkillCatalogsScreen } from './LocalSkillCatalogsScreen';
import { LocalSkillRulesScreen } from './LocalSkillRulesScreen';
import { LocalSkillsScreen } from './LocalSkillsScreen';
import {
  disposeSkillRuntimes,
  lastAlertButton,
  openSkillsPage,
  settle,
  skillFile,
} from './skillsTesting';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
jest.mock('../../on-device/models/engine', () => ({ loadNativeModelContext: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const TEAM = 'https://team.example/skills/';
const PERSONAL = 'https://cat.example/skills/';
const FILES = {
  'ws-one:opencode.json': JSON.stringify({
    skills: ['https://team.example/skills'],
    permission: { skill: { 'internal-*': 'deny' } },
  }),
  'ws-one:.github/skills/review/SKILL.md': skillFile('review'),
  'ws-one:.github/skills/internal-docs/SKILL.md': skillFile('internal-docs'),
  'ws-one:.github/skills/guide/SKILL.md': '---\nname: Team Guide\ndescription: Guide.\n---\nbody',
  'ws-one:.github/skills/silent/SKILL.md': '---\nname: silent\n---\nbody',
  'ws-one:.opencode/skills/quick.md': '---\nname: quick\ndescription: Quick.\n---\nQUICK',
};

function respond(body: string, status = 200) {
  const encoder = new TextEncoder();
  return {
    status,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
  };
}

/** Serves catalog files; `hold` delays one URL until the returned release is called. */
function serve(files: Record<string, string>, hold?: string) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.mocked(fetch).mockImplementation((async (url: string) => {
    if (url === hold) {
      await held;
    }
    const body = files[url];
    return body === undefined ? respond('', 404) : respond(body);
  }) as unknown as typeof fetch);
  return release;
}

const requested = () => jest.mocked(fetch).mock.calls.map(([url]) => url as string);

function row(id: string) {
  return within(screen.getByTestId(`settings-local-skill-row-${id}`));
}

function open(
  element: Parameters<typeof openSkillsPage>[0],
  prepare?: (r: OnDeviceRuntime) => Promise<void>,
) {
  return openSkillsPage(element, FILES, {
    workspaces: [{ id: 'ws-one', name: 'App', isRepository: true }],
    ...(prepare ? { prepare } : {}),
  });
}

beforeEach(() => {
  resetRouterMock();
  router.replace(routes.settingsSkills('on-device'));
  jest.mocked(fetch).mockReset();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
});

afterEach(async () => {
  await disposeSkillRuntimes();
  jest.restoreAllMocks();
});

describe('OpenCode skill management over the real on-device runtime', () => {
  it('turns every skill off and on with Use skills and persists it', async () => {
    const { fake, runtime } = await open(<LocalSkillsScreen />);
    await screen.findByTestId('settings-local-skill-row-review');
    expect(row('review').getByText('/review · Shown to the model')).toBeTruthy();

    await act(async () => {
      fireEvent(screen.getByLabelText('Use skills'), 'valueChange', false);
    });
    await settle();
    expect(runtime.skills.skillsEnabled()).toBe(false);
    expect(JSON.parse(fake.documents.get(PREFERENCES_DOCUMENT) ?? '{}')).toMatchObject({
      skillsEnabled: false,
    });
    expect(screen.getByLabelText('Use skills').props['value']).toBe(false);
    expect(screen.getByText(/^Skills are off: the agent gets no skill list/u)).toBeTruthy();
    expect(row('review').getByText('/review · Hidden from the model')).toBeTruthy();

    await act(async () => {
      fireEvent(screen.getByLabelText('Use skills'), 'valueChange', true);
    });
    await settle();
    expect(runtime.skills.skillsEnabled()).toBe(true);
    expect(row('review').getByText('/review · Shown to the model')).toBeTruthy();
  });

  it('shows which rule decides a skill and lets the user override a project rule', async () => {
    const { runtime } = await open(<LocalSkillsScreen />);
    await screen.findByTestId('settings-local-skill-row-internal-docs');

    // A project opencode.json rule denies it, and the row says where the rule lives.
    expect(row('internal-docs').getByLabelText('Permission for internal-docs, Deny')).toBeTruthy();
    expect(
      row('internal-docs').getByText('Deny · opencode.json permission.skill: internal-*'),
    ).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-local-skill-permission-internal-docs'));
    expect(screen.getByLabelText('Ask').props['accessibilityHint']).toBe(
      'The model asks before loading it. Running /internal-docs or @internal-docs yourself counts as consent.',
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Allow'));
    });
    await settle();
    expect(row('internal-docs').getByText('Allow · your choice')).toBeTruthy();
    expect(runtime.skills.rules()).toEqual([{ pattern: 'internal-docs', effect: 'allow' }]);
    expect(screen.getByLabelText('Permission rules, 1')).toBeTruthy();

    // IDs, display names, flat files, and model visibility are all explicit.
    expect(row('guide').getByText('Team Guide')).toBeTruthy();
    expect(row('guide').getByText('ID guide')).toBeTruthy();
    expect(row('quick').getByText('Project · .opencode/skills/quick.md')).toBeTruthy();
    expect(row('quick').getByText('/quick · Shown to the model · Single file')).toBeTruthy();
    expect(row('silent').getByText('/silent · Hidden from the model: no description')).toBeTruthy();

    // Warnings are for skills that still load; nothing here was skipped.
    expect(screen.queryByTestId('settings-local-skill-diagnostic')).toBeNull();
    const warnings = screen.getAllByTestId('settings-local-skill-warning');
    expect(warnings.some((entry) => within(entry).queryByText(/No description/u))).toBe(true);
    expect(warnings.some((entry) => within(entry).queryByText(/^Portability/u))).toBe(true);
    expect(screen.getByText('Warnings')).toBeTruthy();
    expect(screen.queryByText('Skipped')).toBeNull();

    fireEvent.press(screen.getByLabelText('Permission rules, 1'));
    expect(router.push).toHaveBeenLastCalledWith(routes.settingsSkillRules('on-device'));
    fireEvent.press(screen.getByLabelText('Catalogs'));
    expect(router.push).toHaveBeenLastCalledWith(
      routes.settingsSkillCatalogs('on-device', 'ws-one'),
    );
  });

  it('adds, orders, validates, and deletes pattern rules, and lifts denials', async () => {
    const { runtime } = await open(<LocalSkillRulesScreen />, async (current) => {
      await current.skills.setEnabled('review', false);
    });
    expect(screen.getByLabelText('Back to Skills')).toBeTruthy();
    expect(screen.getByText(/^No rules\./u)).toBeTruthy();
    expect(screen.getByLabelText('Deny, Active')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('settings-local-skill-rule-pattern'), 'internal-*');
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-local-skill-rule-add'));
    });
    fireEvent.press(screen.getByLabelText('Ask'));
    fireEvent.changeText(screen.getByTestId('settings-local-skill-rule-pattern'), 'internal-docs');
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-local-skill-rule-add'));
    });
    expect(runtime.skills.rules()).toEqual([
      { pattern: 'internal-*', effect: 'deny' },
      { pattern: 'internal-docs', effect: 'ask' },
    ]);
    expect(
      screen.getAllByTestId('settings-local-skill-rule').map((entry) =>
        within(entry)
          .getAllByText(/./u)
          .map((node) => String(node.props['children'])),
      ),
    ).toEqual([
      ['internal-*', 'Deny · rule 1 of 2', 'Delete'],
      ['internal-docs', 'Ask · rule 2 of 2', 'Delete'],
    ]);
    // The last matching rule wins.
    let listing = await act(() => runtime.skills.list('ws-one'));
    expect(listing.skills.find((skill) => skill.id === 'internal-docs')?.permission).toMatchObject({
      effect: 'ask',
      rule: { pattern: 'internal-docs', origin: 'user' },
    });

    fireEvent.changeText(screen.getByTestId('settings-local-skill-rule-pattern'), 'x'.repeat(129));
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-local-skill-rule-add'));
    });
    expect(screen.getByText(/rules of 1-128 characters each/u)).toBeTruthy();
    expect(runtime.skills.rules()).toHaveLength(2);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Delete rule 1, internal-*'));
    });
    expect(runtime.skills.rules()).toEqual([{ pattern: 'internal-docs', effect: 'ask' }]);

    expect(screen.getByText('Denied skills')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Remove denial for review'));
    });
    await settle();
    expect(runtime.preferences().disabledSkills).toEqual([]);
    expect(screen.queryByText('Denied skills')).toBeNull();
    listing = await act(() => runtime.skills.list('ws-one'));
    expect(listing.skills.find((skill) => skill.id === 'review')?.enabled).toBe(true);
  });

  it('lists, adds, downloads, and removes catalogs, contacting a URL only when asked', async () => {
    const release = serve(
      {
        [`${PERSONAL}index.json`]: JSON.stringify({
          skills: [
            { name: 'release', version: '1', files: ['SKILL.md'] },
            { name: 'gone', version: '2', files: ['SKILL.md'] },
          ],
        }),
        [`${PERSONAL}release/SKILL.md`]: skillFile('release'),
      },
      `${PERSONAL}index.json`,
    );
    router.push(routes.settingsSkillCatalogs('on-device', 'ws-one'));
    const { runtime } = await open(<LocalSkillCatalogsScreen />);
    expect(screen.getByLabelText('Back to Skills')).toBeTruthy();
    expect(screen.getByText(/only when you tap Download or Update/u)).toBeTruthy();
    await screen.findByLabelText(`Download ${TEAM}`);
    const team = within(screen.getAllByTestId('settings-local-skill-catalog')[0]!);
    expect(team.getByText(TEAM)).toBeTruthy();
    expect(team.getByText('Listed in opencode.json')).toBeTruthy();
    expect(team.getByText('Not downloaded yet')).toBeTruthy();
    expect(screen.queryByLabelText(`Remove ${TEAM}`)).toBeNull();

    // The URL field sits at the bottom; the page scrolls a focused field above the keyboard.
    expect(screen.UNSAFE_getByType(ScrollView).props['automaticallyAdjustKeyboardInsets']).toBe(
      true,
    );
    // Invalid URLs are refused inline; adding a valid one does not download it.
    fireEvent.changeText(
      screen.getByTestId('settings-local-skill-catalog-url'),
      'http://insecure.example/skills',
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-local-skill-catalog-add'));
    });
    expect(screen.getByText(/must be https:\/\/ URLs/u)).toBeTruthy();
    fireEvent.changeText(
      screen.getByTestId('settings-local-skill-catalog-url'),
      'https://cat.example/skills',
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-local-skill-catalog-add'));
    });
    await settle();
    expect(await screen.findByText(PERSONAL)).toBeTruthy();
    expect(screen.getByText('Added on this iPhone')).toBeTruthy();
    expect(screen.getByTestId('settings-local-skill-catalog-url').props['value']).toBe('');
    expect(requested()).toEqual([]);

    // Download is explicit, busy while it runs, and blocks a second download.
    fireEvent.press(screen.getByLabelText(`Download ${PERSONAL}`));
    await waitFor(() =>
      expect(
        screen.getByLabelText(`Download ${PERSONAL}`).props['accessibilityState'],
      ).toMatchObject({ busy: true }),
    );
    expect(screen.getByLabelText(`Download ${TEAM}`).props['accessibilityState']).toMatchObject({
      disabled: true,
    });
    await act(async () => {
      release();
    });
    const result = within(await screen.findByTestId('settings-local-skill-catalog-result'));
    expect(result.getByText('1 downloaded, 0 unchanged, 1 failed')).toBeTruthy();
    expect(result.getByText(/^release 1: downloaded gone 2: failed \(/u)).toBeTruthy();
    expect(screen.getByText(/^Failed: gone: .*404\. Cached: release 1$/u)).toBeTruthy();
    expect(screen.getByLabelText(`Update ${PERSONAL}`)).toBeTruthy();
    expect(requested().every((url) => url.startsWith(PERSONAL))).toBe(true);
    let listing = await act(() => runtime.skills.list('ws-one'));
    expect(listing.skills.find((skill) => skill.id === 'release')).toMatchObject({
      sourceKind: 'catalog',
      source: 'personal',
      sourceRoot: PERSONAL,
    });

    // A failed project catalog download is reported beside that catalog.
    await act(async () => {
      fireEvent.press(screen.getByLabelText(`Download ${TEAM}`));
    });
    await settle();
    expect(
      within(screen.getByTestId('settings-local-skill-catalog-error')).getByText(/404|HTTP/u),
    ).toBeTruthy();

    // Removing a personal catalog asks first and deletes its downloaded skills.
    fireEvent.press(screen.getByLabelText(`Remove ${PERSONAL}`));
    expect(jest.mocked(Alert.alert).mock.calls.at(-1)?.[0]).toBe('Remove catalog?');
    await act(async () => {
      lastAlertButton('Cancel').onPress?.();
    });
    expect(screen.getByText(PERSONAL)).toBeTruthy();
    fireEvent.press(screen.getByLabelText(`Remove ${PERSONAL}`));
    await act(async () => {
      lastAlertButton('Remove').onPress?.();
    });
    await waitFor(() => expect(screen.queryByText(PERSONAL)).toBeNull());
    listing = await act(() => runtime.skills.list('ws-one'));
    expect(listing.skills.some((skill) => skill.id === 'release')).toBe(false);
  });
});

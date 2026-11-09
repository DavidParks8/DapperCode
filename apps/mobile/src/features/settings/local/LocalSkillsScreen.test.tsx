import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { AccessibilityInfo, Alert } from 'react-native';

import { router } from 'expo-router';
import { resetRouterMock } from '@shared/testing/expoRouterMock';
import { routes } from '@shell/navigation/routes';
import { PREFERENCES_DOCUMENT } from '../../on-device/runtime/preferences';
import type { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import type { LocalSkillListing } from '../../on-device/runtime/skills';
import type { LocalWorkspace } from '../../on-device/workspaces/types';
import { LocalSkillImportScreen } from './LocalSkillImportScreen';
import { LocalSkillInfoScreen } from './LocalSkillInfoScreen';
import { LocalSkillsScreen } from './LocalSkillsScreen';
import {
  disposeSkillRuntimes,
  lastAlertButton,
  openSkillsPage,
  settle,
  SKILL_WORKSPACES as WORKSPACES,
  skillFile as skill,
} from './skillsTesting';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
jest.mock('../../on-device/models/engine', () => ({ loadNativeModelContext: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const FILES = {
  'ws-one:.github/skills/review/SKILL.md': skill(
    'review',
    'argument-hint: "<file>"\nallowed-tools: web_fetch git_push\ncompatibility: Needs network access.\n',
  ),
  // Unterminated frontmatter is invalid under every skill parser.
  'ws-one:.github/skills/broken/SKILL.md': '---\nname: broken\n',
  'ws-one:.claude/skills/review/SKILL.md': skill('review'),
  'ws-one:.agents/skills/plan/SKILL.md': skill(
    'plan',
    'context: fork\ndisable-model-invocation: true\n',
  ),
  'ws-two:.github/skills/lint/SKILL.md': skill('lint'),
  'ws-two:.github/skills/lint/rules.md': 'Prefer const.',
  'ws-two:.github/skills/zeta/SKILL.md': skill('zeta'),
  'ws-two:skills/notes/SKILL.md': skill('notes', 'user-invocable: false\n'),
  'ws-two:skills/notes/template.md': 'Template',
  'ws-two:skills/notes/a/b/c/d/e/f/deep.md': 'Too deep',
  'ws-two:skills/bad/SKILL.md': '---\nname: bad\n',
  'ws-two:skills/empty/README.md': 'No skill here',
};

function open(
  element: ReactElement,
  {
    files = FILES,
    workspaces = WORKSPACES,
  }: { files?: Record<string, string>; workspaces?: LocalWorkspace[] } = {},
  prepare?: (runtime: OnDeviceRuntime) => Promise<void>,
) {
  return openSkillsPage(element, files, { workspaces, prepare });
}

/** The runtime's listing, read inside act because listing republishes slash commands. */
async function listed(runtime: OnDeviceRuntime): Promise<LocalSkillListing> {
  let listing: LocalSkillListing = { skills: [], diagnostics: [] };
  await act(async () => {
    listing = await runtime.skills.list('ws-one');
  });
  return listing;
}

function row(name: string) {
  return within(screen.getByTestId(`settings-local-skill-row-${name}`));
}

/** Opens a skill's Allow / Ask / Deny sheet and picks one option. */
async function choosePermission(id: string, option: string) {
  fireEvent.press(screen.getByTestId(`settings-local-skill-permission-${id}`));
  await act(async () => {
    fireEvent.press(screen.getByLabelText(option));
  });
  await settle();
}

beforeEach(() => {
  resetRouterMock();
  router.replace(routes.settingsSkills('on-device'));
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
});

afterEach(async () => {
  await disposeSkillRuntimes();
  jest.restoreAllMocks();
});

describe('Skills settings over the real on-device runtime', () => {
  it('merges the new-chat workspace’s project skills with personal skills as the agent sees them', async () => {
    await open(<LocalSkillsScreen />, {}, async (runtime) => {
      await runtime.skills.importPersonal('ws-two', 'skills/notes');
      await runtime.selectWorkspace('ws-one');
    });

    expect(await screen.findByTestId('settings-local-skill-row-review')).toBeTruthy();
    expect(screen.getByLabelText('Workspace, App')).toBeTruthy();
    expect(screen.getByLabelText('Back to Settings')).toBeTruthy();

    // The higher-precedence root wins; the agent never sees the shadowed or invalid copies.
    expect(row('review').getByText('Project · .github/skills/review')).toBeTruthy();
    expect(row('review').getByText('/review <file> · Shown to the model')).toBeTruthy();
    expect(row('review').getByText('Allow · no rule matches')).toBeTruthy();
    expect(row('review').getByLabelText('Permission for review, Allow')).toBeTruthy();
    expect(
      row('review').getByText(
        'Pre-approves web_fetch, git_push: they run without confirmation once the skill loads.',
      ),
    ).toBeTruthy();
    expect(
      row('plan').getByText(
        '/plan · Hidden from the model: loads only with /plan · Runs in a forked agent',
      ),
    ).toBeTruthy();
    expect(row('notes').getByText('Personal · every workspace')).toBeTruthy();
    expect(row('notes').getByText('No slash command · Shown to the model')).toBeTruthy();
    expect(row('notes').getByLabelText('Remove notes')).toBeTruthy();
    expect(row('review').queryByLabelText('Remove review')).toBeNull();
    expect(screen.queryByTestId('settings-local-skill-row-broken')).toBeNull();

    const diagnostics = screen.getAllByTestId('settings-local-skill-diagnostic');
    expect(
      diagnostics.map((entry) => within(entry).getAllByText(/./u)[0]?.props['children']),
    ).toEqual(['.github/skills/broken', '.claude/skills/review']);
    expect(
      within(diagnostics[1]!).getByText('Shadowed by the project skill .github/skills/review.'),
    ).toBeTruthy();
    expect(within(diagnostics[0]!).getByText(/frontmatter/u)).toBeTruthy();
  });

  it('denies, asks, and resets a skill through the runtime and persists each choice', async () => {
    const { fake, runtime } = await open(<LocalSkillsScreen />);
    await screen.findByTestId('settings-local-skill-row-review');
    const saved = () =>
      JSON.parse(fake.documents.get(PREFERENCES_DOCUMENT) ?? '{}') as {
        disabledSkills?: string[];
        skillRules?: unknown[];
      };

    // Deny is the Copilot-style off switch: hidden from the model and slash commands.
    await choosePermission('review', 'Deny');
    expect(row('review').getByLabelText('Permission for review, Deny')).toBeTruthy();
    expect(row('review').getByText('Deny · your choice')).toBeTruthy();
    expect(row('review').getByText('/review <file> · Hidden from the model')).toBeTruthy();
    expect(saved().disabledSkills).toEqual(['review']);
    expect((await listed(runtime)).skills.find((s) => s.id === 'review')).toMatchObject({
      enabled: false,
      advertised: false,
    });

    // Ask replaces the denial with an exact-ID rule after the user's other rules.
    await choosePermission('review', 'Ask');
    expect(row('review').getByText('Ask · your choice')).toBeTruthy();
    expect(saved()).toMatchObject({
      disabledSkills: [],
      skillRules: [{ pattern: 'review', effect: 'ask' }],
    });

    // Follow rules appears only for an overridden skill and removes the choice.
    fireEvent.press(screen.getByTestId('settings-local-skill-permission-plan'));
    expect(screen.queryByLabelText('Follow rules')).toBeNull();
    fireEvent.press(screen.getByTestId('selection-sheet-close'));
    await choosePermission('review', 'Follow rules');
    expect(row('review').getByText('Allow · no rule matches')).toBeTruthy();
    expect(runtime.skills.rules()).toEqual([]);
    expect(runtime.preferences().disabledSkills).toEqual([]);
  });

  it('shows a failed permission change and a failed listing explicitly, with a retry', async () => {
    const { runtime } = await open(<LocalSkillsScreen />, {}, async (current) => {
      jest
        .spyOn(current.skills, 'list')
        .mockRejectedValueOnce(new Error('The workspace could not be read.'));
    });
    expect(await screen.findByText('The workspace could not be read.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Try again'));
    await settle();
    expect(screen.getByTestId('settings-local-skill-row-review')).toBeTruthy();

    jest.spyOn(runtime.skills, 'setEnabled').mockRejectedValueOnce(new Error('Disk full.'));
    await choosePermission('plan', 'Deny');
    expect(screen.getByText('Disk full.')).toBeTruthy();
    expect(row('plan').getByLabelText('Permission for plan, Allow')).toBeTruthy();
    // The next change clears the stale failure.
    await choosePermission('plan', 'Deny');
    expect(screen.queryByText('Disk full.')).toBeNull();
    expect(row('plan').getByLabelText('Permission for plan, Deny')).toBeTruthy();
  });

  it('switches workspaces and refreshes when the runtime announces a skills change', async () => {
    const { runtime } = await open(<LocalSkillsScreen />);
    expect(await screen.findByTestId('settings-local-skill-row-review')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Workspace, App'));
    fireEvent.press(screen.getByLabelText('Skills Repo'));
    expect(await screen.findByTestId('settings-local-skill-row-lint')).toBeTruthy();
    expect(screen.getByLabelText('Workspace, Skills Repo')).toBeTruthy();
    expect(screen.queryByTestId('settings-local-skill-row-review')).toBeNull();

    // A personal skill added elsewhere appears without reopening the page.
    expect(screen.queryByTestId('settings-local-skill-row-notes')).toBeNull();
    await act(async () => {
      await runtime.skills.importPersonal('ws-two', 'skills/notes');
    });
    expect(await screen.findByTestId('settings-local-skill-row-notes')).toBeTruthy();
  });

  it('explains where skills come from when there are none', async () => {
    await open(<LocalSkillsScreen />, { files: {}, workspaces: [WORKSPACES[0]!] });
    expect(
      await screen.findByText(
        'No project skills in App. Add a folder with a SKILL.md file, such as .github/skills/<name>/SKILL.md.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/In place of gh skill install, clone a skills repository as a workspace/u),
    ).toBeTruthy();
    expect(screen.queryByTestId('settings-local-skill-diagnostic')).toBeNull();
    fireEvent.press(screen.getByTestId('settings-local-skill-add'));
    expect(router.push).toHaveBeenLastCalledWith(routes.settingsSkillImport('on-device', 'ws-one'));
    screen.unmount();

    await open(<LocalSkillsScreen />, { files: {}, workspaces: [] });
    expect(screen.getByText('No workspaces yet')).toBeTruthy();
    expect(screen.queryByTestId('settings-local-skill-add')).toBeNull();
  });

  it('removes a personal skill only after confirmation', async () => {
    const { runtime } = await open(<LocalSkillsScreen />, {}, async (current) => {
      await current.skills.importPersonal('ws-two', 'skills/notes');
    });
    const remove = jest.spyOn(runtime.skills, 'removePersonal');
    fireEvent.press(await screen.findByLabelText('Remove notes'));
    expect(jest.mocked(Alert.alert).mock.calls.at(-1)?.[0]).toBe('Remove notes?');
    await act(async () => {
      lastAlertButton('Cancel').onPress?.();
    });
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-local-skill-row-notes')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Remove notes'));
    await act(async () => {
      lastAlertButton('Remove').onPress?.();
    });
    await waitFor(() => expect(screen.queryByTestId('settings-local-skill-row-notes')).toBeNull());
    expect(remove).toHaveBeenCalledWith('notes');
    expect((await listed(runtime)).skills.map((entry) => entry.name)).toEqual(['review', 'plan']);
  });

  it('opens skill details with location, hint, compatibility, and the pre-approved tools warning', async () => {
    await open(<LocalSkillsScreen />);
    fireEvent.press(await screen.findByLabelText('review details'));
    expect(router.push).toHaveBeenLastCalledWith(
      routes.settingsSkill('on-device', 'review', 'ws-one'),
    );
    screen.unmount();

    await open(<LocalSkillInfoScreen />);
    expect(await screen.findByText('.github/skills/review/SKILL.md')).toBeTruthy();
    expect(screen.getByLabelText('Back to Skills')).toBeTruthy();
    expect(screen.getByText('/review')).toBeTruthy();
    expect(screen.getByText('<file>')).toBeTruthy();
    expect(screen.getByText('The model can load it when relevant')).toBeTruthy();
    expect(screen.getByText('The current conversation')).toBeTruthy();
    expect(screen.getByText('Needs network access.')).toBeTruthy();
    expect(
      within(screen.getByTestId('settings-local-skill-allowed-tools')).getByText(
        'web_fetch, git_push',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'These run without asking for confirmation once the skill loads, for the rest of that run; shell and unknown tools are ignored. Only enable skills you have reviewed.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Permission, Allow')).toBeTruthy();
    expect(screen.getByText('ID')).toBeTruthy();
    expect(screen.getByText('Project skills folder · .github/skills')).toBeTruthy();
    expect(screen.getByText('Folder with SKILL.md')).toBeTruthy();
    expect(screen.getByText('Shown to the model')).toBeTruthy();
    // The info page changes the permission with the same sheet as the list.
    fireEvent.press(screen.getByLabelText('Permission, Allow'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Ask'));
    });
    await settle();
    expect(await screen.findByLabelText('Permission, Ask')).toBeTruthy();
    expect(screen.getByText(/^Ask · your choice\. Ask means the model asks/u)).toBeTruthy();
    // The skill can be reviewed before it is enabled: what the agent reads, and what it bundles.
    expect(
      await within(screen.getByTestId('settings-local-skill-source')).findByText(
        FILES['ws-one:.github/skills/review/SKILL.md'].trimEnd(),
      ),
    ).toBeTruthy();
    expect(screen.getByText('What the agent reads when it loads this skill.')).toBeTruthy();
    expect(
      within(screen.getByTestId('settings-local-skill-files')).getByText('No bundled files'),
    ).toBeTruthy();
    // Project skills are changed in their workspace, not removed here.
    expect(screen.queryByTestId('settings-local-skill-remove')).toBeNull();
    fireEvent.press(screen.getByLabelText('Back to Skills'));
    expect(router.back).toHaveBeenCalled();
  });

  it('removes a personal skill from its details page and returns to Skills', async () => {
    router.push(routes.settingsSkill('on-device', 'notes', 'ws-one'));
    const { runtime } = await open(<LocalSkillInfoScreen />, {}, async (current) => {
      await current.skills.importPersonal('ws-two', 'skills/notes');
    });
    expect(await screen.findByText('Stored on this iPhone')).toBeTruthy();
    expect(screen.getByText('Off (user-invocable: false)')).toBeTruthy();
    // A personal copy shows what was imported, including the files left behind.
    expect(
      await within(screen.getByTestId('settings-local-skill-source')).findByText(
        FILES['ws-two:skills/notes/SKILL.md'].trimEnd(),
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('settings-local-skill-files')).getByText('template.md'),
    ).toBeTruthy();
    expect(screen.getByText('a/b/c/d/e/f: Deeper than 6 directories.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-local-skill-remove'));
    await act(async () => {
      lastAlertButton('Remove').onPress?.();
    });
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect((await listed(runtime)).skills.map((entry) => entry.name)).not.toContain('notes');
  });

  it('adds personal skills from a discovered skill or a browsed folder and reports skipped files', async () => {
    router.push(routes.settingsSkillImport('on-device', 'ws-two'));
    const { runtime } = await open(<LocalSkillImportScreen />);
    expect(screen.getByLabelText('Back to Skills')).toBeTruthy();
    expect(screen.getByLabelText('Workspace, Skills Repo')).toBeTruthy();

    fireEvent.press(await screen.findByLabelText('Add lint'));
    expect(await screen.findByText('Added lint')).toBeTruthy();
    const copied = within(screen.getByTestId('settings-local-skill-added'));
    expect(copied.getByText('2 files copied: SKILL.md, rules.md')).toBeTruthy();
    expect(screen.queryByTestId('settings-local-skill-add-skipped')).toBeNull();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'Added lint. 2 copied, 0 skipped.',
    );
    // The result sits right under the skill that was added, not at the top of a long page.
    expect(
      screen.getAllByText(/^(lint|zeta|Added lint)$/u).map((node) => node.props['children']),
    ).toEqual(['lint', 'Added lint', 'zeta']);

    // Browse a cloned repository whose skills are outside the project roots.
    fireEvent.press(screen.getByLabelText('skills'));
    fireEvent.press(await screen.findByLabelText('notes'));
    expect(await screen.findByText('/skills/notes')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-local-skill-browse-add'));
    expect(await screen.findByText('Added notes')).toBeTruthy();
    expect(
      within(screen.getByTestId('settings-local-skill-add-skipped')).getByText(
        'a/b/c/d/e/f: Deeper than 6 directories.',
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('settings-local-skill-added')).getByText(
        '2 files copied: SKILL.md, template.md',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Added lint')).toBeNull();

    // An invalid SKILL.md is reported, and a folder without one cannot be added.
    fireEvent.press(screen.getByLabelText('Parent folder'));
    expect(screen.queryByText('Added notes')).toBeNull();
    fireEvent.press(await screen.findByLabelText('bad'));
    fireEvent.press(await screen.findByLabelText('Add bad'));
    expect(
      await within(await screen.findByTestId('settings-local-skill-add-error')).findByText(
        /frontmatter/u,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Not added')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Parent folder'));
    fireEvent.press(await screen.findByLabelText('empty'));
    expect(await screen.findByText('No folders here.')).toBeTruthy();
    expect(screen.queryByTestId('settings-local-skill-browse-add')).toBeNull();

    const listing = await listed(runtime);
    expect(
      listing.skills.filter((entry) => entry.source === 'personal').map((entry) => entry.name),
    ).toEqual(['lint', 'notes']);
  });

  it('shows a failed add next to the skill and keeps every Add control usable afterwards', async () => {
    router.push(routes.settingsSkillImport('on-device', 'ws-two'));
    const { runtime } = await open(<LocalSkillImportScreen />);
    let finish: (error: Error) => void = () => undefined;
    jest.spyOn(runtime.skills, 'importPersonal').mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          finish = reject;
        }),
    );
    fireEvent.press(await screen.findByLabelText('Add zeta'));
    // While one add runs, the others wait instead of racing it.
    expect(screen.getByLabelText('Add zeta').props['accessibilityState']).toMatchObject({
      busy: true,
    });
    expect(screen.getByLabelText('Add lint').props['accessibilityState']).toMatchObject({
      disabled: true,
    });
    await act(async () => {
      finish(new Error('At most 64 personal skills can be saved.'));
    });
    expect(
      within(screen.getByTestId('settings-local-skill-add-error')).getByText(
        'At most 64 personal skills can be saved.',
      ),
    ).toBeTruthy();
    expect(
      screen.getAllByText(/^(lint|zeta|Not added)$/u).map((node) => node.props['children']),
    ).toEqual(['lint', 'zeta', 'Not added']);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'At most 64 personal skills can be saved.',
    );
    expect(screen.getByLabelText('Add lint').props['accessibilityState']).toMatchObject({
      disabled: false,
      busy: false,
    });
  });
});

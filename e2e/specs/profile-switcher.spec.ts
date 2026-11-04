import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { selectors } from '../fixtures/selectors.ts';
import {
  expectContainedWithin,
  expectNoOverlap,
  expectStackedVertically,
  expectTouchTarget,
  expectVisible,
  expectWithinViewport,
} from '../layout/assertions.ts';

test.describe('profile switching', () => {
  test('a single profile offers no switcher on web', async ({ app }) => {
    await expect(selectors.newChatProfileSwitcher(app.page)).toHaveCount(0);
    await app.openDrawer();
    await expect(selectors.drawerProfileSwitcher(app.page)).toHaveCount(0);
  });

  test('the drawer names the open profile above the folder filter', async ({ createApp }) => {
    const app = await createApp({ additionalProfileNames: ['Studio'] });
    await app.openDrawer();
    const row = selectors.drawerProfileSwitcher(app.page);
    const folder = selectors.drawerFolderFilter(app.page);
    await expectVisible(row);
    await expect(row).toHaveAccessibleName(/^Where agents run, Harness, Connected · /);
    await expectContainedWithin(row, selectors.drawer(app.page));
    await expectTouchTarget(row, 44);
    await expectStackedVertically([selectors.drawerSearch(app.page), row, folder]);
    await expectNoOverlap(row, folder);
    await expectNoOverlap(row, selectors.drawerSearch(app.page));

    await row.click();
    await expectVisible(selectors.profileOption(app.page, 'Harness'));
    await expectVisible(selectors.profileOption(app.page, 'Studio'));
    await expectVisible(selectors.profileOption(app.page, 'Add bridge'));
  });

  test('a new chat shows where it runs without crowding the workspace control', async ({
    createApp,
  }) => {
    const app = await createApp({ additionalProfileNames: ['Studio'], chatId: 'new' });
    const capsule = selectors.newChatProfileSwitcher(app.page);
    const workspace = selectors.newChatWorkspace(app.page);
    await expectVisible(capsule);
    await expectWithinViewport(capsule);
    await expectTouchTarget(capsule, 44);
    await expectNoOverlap(capsule, workspace);
    await expectNoOverlap(capsule, selectors.composer(app.page));
    await expect(selectors.localSetupGuide(app.page)).toHaveCount(0);
  });
});

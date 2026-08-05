import { test as base, expect, type Locator, type Page } from '@playwright/test';

import { ensureWebBuild } from '../harness/webBuild.ts';
import {
  startHarnessBridge,
  type HarnessBridge,
  type HarnessBridgeOptions,
} from '../harness/bridgeServer.ts';
import { startStaticSiteServer, type StaticSiteServer } from '../harness/staticServer.ts';
import { FIXED_NOW_MS } from '../harness/protocol.ts';
import { settleLayout, type Rect, readRect } from '../layout/geometry.ts';
import { selectors } from './selectors.ts';
import { seedBridgeProfileScript } from './seed.ts';

export interface AppOptions extends HarnessBridgeOptions {
  /** Chat to open directly. Defaults to the app's own landing redirect. */
  readonly chatId?: string;
}

export interface AppHandle {
  readonly page: Page;
  readonly bridge: HarnessBridge;
  /** Console errors and uncaught exceptions observed since load. */
  readonly errors: readonly string[];
  /** Navigates to a chat route and waits for the transcript to settle. */
  openChat(chatId: string): Promise<void>;
  /** Opens the navigation drawer and waits for the slide animation to come to rest. */
  openDrawer(): Promise<void>;
  /** Waits until two consecutive frames report the same geometry for `target`. */
  settle(): Promise<void>;
}

interface WorkerFixtures {
  site: StaticSiteServer;
}

interface TestFixtures {
  bridge: HarnessBridge;
  app: AppHandle;
  createApp: (options?: AppOptions) => Promise<AppHandle>;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  /**
   * One static server per worker, always on an ephemeral port. The bundle itself is built once and
   * shared, but nothing about serving it is global, so concurrent runs never contend.
   */
  site: [
    async ({}, use) => {
      const build = await ensureWebBuild();
      const server = await startStaticSiteServer(build.dir);
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  /** A fresh bridge per test keeps scenario mutations from leaking between specs. */
  bridge: async ({}, use) => {
    const bridge = await startHarnessBridge();
    await use(bridge);
    await bridge.close();
  },

  createApp: async ({ page, site }, use) => {
    const started: HarnessBridge[] = [];

    const createApp = async (options: AppOptions = {}): Promise<AppHandle> => {
      const bridge = await startHarnessBridge(options);
      started.push(bridge);
      const handle = await launchApp(page, site, bridge, options);
      return handle;
    };

    await use(createApp);

    for (const bridge of started) {
      await bridge.close();
    }
  },

  /** The common case: a booted app pointed at the default scenario. */
  app: async ({ page, site, bridge }, use) => {
    const handle = await launchApp(page, site, bridge, {});
    await use(handle);
  },
});

async function launchApp(
  page: Page,
  site: StaticSiteServer,
  bridge: HarnessBridge,
  options: AppOptions,
): Promise<AppHandle> {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });

  await page.addInitScript(seedBridgeProfileScript, {
    bridgeUrl: bridge.url,
    bridgeToken: bridge.token,
    nowMs: FIXED_NOW_MS,
  });

  const target = options.chatId ? `${site.url}${chatRoute(options.chatId)}` : site.url;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await bridge.waitForConnection();
  await waitForChatReady(page);

  const handle: AppHandle = {
    page,
    bridge,
    errors,
    async openChat(chatId: string) {
      await page.goto(`${site.url}${chatRoute(chatId)}`, { waitUntil: 'domcontentloaded' });
      await bridge.waitForConnection();
      await waitForChatReady(page);
    },
    async openDrawer() {
      // The wide shell docks the drawer permanently, so there is no button to press and nothing to
      // animate. Treating that as "already open" keeps drawer specs meaningful at every size.
      const opener = page.getByLabel('Open navigation drawer');
      if ((await opener.count()) > 0) {
        await opener.first().click();
      }
      const drawer = selectors.drawer(page);
      await expect(drawer).toBeVisible();
      await waitForRestingPosition(drawer);
    },
    async settle() {
      await settleLayout(page);
    },
  };
  return handle;
}

/**
 * The chat surface hydrates in stages: the shell paints, the bridge connects, then the thread and
 * its session metadata arrive. Measuring before the last stage produces geometry for a half-built
 * screen, which is how a layout suite becomes flaky.
 *
 * The chrome and the composer are the two surfaces present on every route, including the empty
 * "new chat" landing where no transcript list exists at all, so they are what readiness waits on.
 */
async function waitForChatReady(page: Page): Promise<void> {
  await expect(selectors.topChrome(page)).toBeVisible();
  await expect(selectors.composer(page)).toBeVisible();
  await settleLayout(page);
}

/** Polls until an element reports the same geometry twice in a row, i.e. its animation has ended. */
async function waitForRestingPosition(target: Locator, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let previous: Rect | null = null;
  while (Date.now() < deadline) {
    const current = await readRect(target);
    if (
      previous !== null &&
      Math.abs(previous.left - current.left) < 0.5 &&
      Math.abs(previous.top - current.top) < 0.5 &&
      Math.abs(previous.width - current.width) < 0.5 &&
      Math.abs(previous.height - current.height) < 0.5
    ) {
      return;
    }
    previous = current;
    await target.page().waitForTimeout(50);
  }
  throw new Error('Timed out waiting for the drawer to reach a resting position.');
}

export const PROFILE_ID = 'harness-profile';

export function chatRoute(chatId: string): string {
  return `/profiles/${PROFILE_ID}/chats/${chatId}`;
}

export { expect } from '@playwright/test';

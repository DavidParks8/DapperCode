import { test as base, expect, type Locator, type Page } from '@playwright/test';

import { ensureWebBuild } from '../harness/webBuild.ts';
import { startRealBridge, type RealBridge, type RealBridgeOptions } from '../harness/realBridge.ts';
import { startStaticSiteServer, type StaticSiteServer } from '../harness/staticServer.ts';
import { FIXED_NOW_MS } from '../harness/scenario.ts';
import { settleLayout, type Rect, readRect } from '../layout/geometry.ts';
import { selectors } from './selectors.ts';
import { seedBridgeProfileScript } from './seed.ts';

export interface AppOptions extends RealBridgeOptions {
  /** Chat to open directly. Defaults to the app's own landing redirect. */
  readonly chatId?: string;
}

export interface AppHandle {
  readonly page: Page;
  readonly bridge: RealBridge;
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
  bridge: RealBridge;
  app: AppHandle;
  createApp: (options?: AppOptions) => Promise<AppHandle>;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  /**
   * One static server per worker, always on an ephemeral port. The bundle itself is built once and
   * shared, but nothing about serving it is global, so concurrent runs never contend.
   *
   * `globalSetup` already forced the build before any worker existed, so `ensureWebBuild` here is
   * normally just the fast, already-complete-on-disk check. It stays in the fixture too as a
   * defense-in-depth fallback, but nothing about worker readiness is allowed to depend on winning a
   * race against a cold `expo export`.
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
    const bridge = await startRealBridge();
    await use(bridge);
    await bridge.close();
  },

  createApp: async ({ page, site }, use) => {
    const started: RealBridge[] = [];
    const handles: AppHandle[] = [];

    const createApp = async (options: AppOptions = {}): Promise<AppHandle> => {
      const bridge = await startRealBridge(options);
      started.push(bridge);
      const handle = await launchApp(page, site, bridge, options);
      handles.push(handle);
      return handle;
    };

    await use(createApp);

    const appFailure = describeAppErrors(handles);
    await page.close();

    for (const bridge of started) {
      await bridge.close();
    }
    if (appFailure) {
      throw new Error(appFailure);
    }
  },

  /** The common case: a booted app pointed at the default scenario. */
  app: async ({ page, site, bridge }, use) => {
    const handle = await launchApp(page, site, bridge, {});
    await use(handle);
    const failure = describeAppErrors([handle]);
    await page.close();
    if (failure) {
      throw new Error(failure);
    }
  },
});

/**
 * Uncaught application errors fail the test even when the geometry checks pass.
 *
 * Layout assertions only look at boxes, so a component that threw during render can still leave a
 * plausibly-positioned shell behind. Without this, the suite would report green on a broken app.
 */
function describeAppErrors(handles: readonly AppHandle[]): string | null {
  const errors = handles.flatMap((handle) => [...handle.errors]);
  if (errors.length === 0) {
    return null;
  }
  return [
    `The app reported ${String(errors.length)} console error(s) or uncaught exception(s):`,
    ...errors.map((error) => `  - ${error}`),
  ].join('\n');
}

/**
 * Pages that have already booted an app.
 *
 * Every launch installs an init script and console listeners on the same Playwright page. Init
 * scripts persist across navigation and run in an unspecified order, so a second launch would leave
 * two scripts racing to seed the same profile and two listeners recording the same errors, while
 * both handles silently referred to one page. That is a confusing failure to debug, so it is
 * refused outright.
 */
const launchedPages = new WeakSet<Page>();

async function launchApp(
  page: Page,
  site: StaticSiteServer,
  bridge: RealBridge,
  options: AppOptions,
): Promise<AppHandle> {
  if (launchedPages.has(page)) {
    throw new Error(
      'This page has already booted an app. Each test gets one page, so requesting both the `app` ' +
        'and `createApp` fixtures, or calling `createApp` twice, would seed the same page twice ' +
        'and race. Use `createApp` alone for a custom scenario, or `app` alone for the default.',
    );
  }
  launchedPages.add(page);

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

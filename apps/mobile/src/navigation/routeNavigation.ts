import { router, type Href } from 'expo-router';

/**
 * Fully resets navigation history back to a single screen. This issues an untargeted
 * `POP_TO_TOP`, which React Navigation bubbles from the currently focused screen up through
 * parent navigators until one can handle it — so it can clear state well beyond the screen the
 * caller is leaving (a different chat's pushed Agent/Git history, a Settings modal, etc).
 *
 * Only reach for this when a genuinely global reset is intended, such as activating a
 * different bridge profile, where the entire previous navigation tree belongs to an identity
 * that no longer applies. Ordinary root navigation (switching the active chat, the Browser,
 * Settings, or onboarding) must not call this — use `navigateRoot`/`replaceRoot` instead, which
 * only ever touch the specific navigator the destination route lives in.
 */
export function dismissAllPresentedRoutes(): void {
  if (router.canDismiss()) {
    router.dismissAll();
  }
}

/**
 * Lands on `href`, first asking `router.dismissTo` to unwind only the route(s) presented on
 * top of it within its own navigator (a pushed Agent/Git screen over the same chat, a
 * `presentation: 'modal'` connection screen over Settings, etc). `dismissTo` computes the
 * specific navigator where the current and target routes diverge and only ever touches that
 * navigator, so it cannot reach into an unrelated sibling stack (another Drawer screen's own
 * history). When the destination isn't already reachable within that scope — e.g. switching
 * between Drawer siblings such as Browser and Settings — `dismissTo` is a no-op, so `apply`
 * still performs the real navigation. Both calls are queued synchronously before Expo Router
 * flushes them, so only the final, combined state is ever rendered.
 */
function dismissToThenApply(href: Href, apply: (href: Href) => void): void {
  router.dismissTo(href);
  apply(href);
}

/**
 * Navigates to `href` without disturbing navigator state that has nothing to do with the
 * destination. See `dismissToThenApply` for why this is safe to use instead of a blanket
 * dismiss-then-navigate.
 */
export function navigateRoot(href: Href): void {
  dismissToThenApply(href, router.navigate);
}

/**
 * Replaces the current screen with `href` without disturbing unrelated navigator state. See
 * `dismissToThenApply` for why this is safe to use instead of a blanket dismiss-then-replace.
 */
export function replaceRoot(href: Href): void {
  dismissToThenApply(href, router.replace);
}


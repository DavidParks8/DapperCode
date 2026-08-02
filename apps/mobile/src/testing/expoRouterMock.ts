import { useEffect, useSyncExternalStore, type ReactNode } from 'react';

interface MockRoute {
  pathname: string;
  params: Record<string, string | number>;
}

type MockHref = string | { pathname: string; params?: Record<string, string | number> };

let stack: MockRoute[] = [{ pathname: '/', params: {} }];
const listeners = new Set<() => void>();

function currentRoute(): MockRoute {
  return stack[stack.length - 1];
}

function resolveHref(href: MockHref): MockRoute {
  if (typeof href === 'string') {
    return { pathname: href, params: {} };
  }
  const params = { ...(href.params ?? {}) };
  let pathname = href.pathname;
  for (const [key, value] of Object.entries(params)) {
    pathname = pathname.replace(`[${key}]`, encodeURIComponent(String(value)));
  }
  return { pathname, params };
}

function publish(): void {
  for (const listener of listeners) {
    listener();
  }
}

const router = {
  back: jest.fn(() => {
    if (stack.length > 1) {
      stack = stack.slice(0, -1);
      publish();
    }
  }),
  canGoBack: jest.fn(() => stack.length > 1),
  canDismiss: jest.fn(() => stack.length > 1),
  dismiss: jest.fn(),
  dismissAll: jest.fn(() => {
    stack = [stack[0]];
    publish();
  }),
  dismissTo: jest.fn((href: MockHref) => {
    const target = resolveHref(href);
    let targetIndex = -1;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].pathname === target.pathname) {
        targetIndex = index;
        break;
      }
    }
    stack = targetIndex >= 0 ? stack.slice(0, targetIndex + 1) : [...stack.slice(0, -1), target];
    publish();
  }),
  navigate: jest.fn((href: MockHref) => {
    stack = [...stack.slice(0, -1), resolveHref(href)];
    publish();
  }),
  push: jest.fn((href: MockHref) => {
    stack = [...stack, resolveHref(href)];
    publish();
  }),
  replace: jest.fn((href: MockHref) => {
    stack = [...stack.slice(0, -1), resolveHref(href)];
    publish();
  }),
  setParams: jest.fn((params: Record<string, string | number>) => {
    const current = currentRoute();
    let pathname = current.pathname;
    for (const [key, value] of Object.entries(params)) {
      const previous = current.params[key];
      if (previous !== undefined) {
        pathname = pathname.replace(
          encodeURIComponent(String(previous)),
          encodeURIComponent(String(value)),
        );
      }
    }
    stack = [
      ...stack.slice(0, -1),
      {
        pathname,
        params: { ...current.params, ...params },
      },
    ];
    publish();
  }),
};

function useRoute() {
  return useSyncExternalStore(
    (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentRoute,
    currentRoute,
  );
}

export function resetRouterMock(): void {
  stack = [{ pathname: '/', params: {} }];
  for (const value of Object.values(router)) {
    if (typeof value === 'function' && 'mockClear' in value) {
      (value as jest.Mock).mockClear();
    }
  }
  publish();
}

export { router };

export const useGlobalSearchParams = () => useRoute().params;
export const useLocalSearchParams = () => useRoute().params;
export const usePathname = () => useRoute().pathname;
export const useRouter = () => router;
export const useFocusEffect = (effect: () => void | (() => void)) => {
  useEffect(effect, [effect]);
};

export const Stack = Object.assign(() => null, {
  Protected: ({ children }: { children: ReactNode }) => children,
  Screen: () => null,
});

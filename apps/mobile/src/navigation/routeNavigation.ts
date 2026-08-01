import { router, type Href } from 'expo-router';

export function dismissNestedRoutes(): void {
  if (router.canDismiss()) {
    router.dismissAll();
  }
}

export function navigateRoot(href: Href): void {
  dismissNestedRoutes();
  router.navigate(href);
}

export function replaceRoot(href: Href): void {
  dismissNestedRoutes();
  router.replace(href);
}

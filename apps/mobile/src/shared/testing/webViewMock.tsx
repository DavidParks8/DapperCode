import { createElement, forwardRef, useImperativeHandle } from 'react';

export const WebView = forwardRef(function MockWebView(
  props: Record<string, unknown>,
  ref: React.ForwardedRef<Record<string, unknown>>,
) {
  useImperativeHandle(ref, () => ({
    postMessage: () => undefined,
    injectJavaScript: () => undefined,
    reload: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
  }));
  return createElement('mock-web-view', props);
});

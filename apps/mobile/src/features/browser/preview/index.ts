export {
  dedupeRecentPreviewTargets,
  type BrowserPreviewViewportPreset,
  type BrowserPreviewViewportSpec,
  normalizeBrowserPreviewViewportSpec,
  normalizePreviewTargetInput,
} from './constants';
export {
  extractLocalPreviewUrls,
  isLocalPreviewCandidateUrl,
  pushRecentPreviewTarget,
} from './discovery';
export {
  applyBrowserPreviewShellMode,
  applyBrowserPreviewViewportPreset,
  buildBrowserPreviewBootstrapUrl,
  buildBrowserPreviewViewportNavigationUrl,
  getBrowserPreviewOrigin,
  getBrowserPreviewShellRequestKey,
  getNativeBrowserPreviewShellMode,
  isSameOriginUrl,
  mapBrowserPreviewNavigationUrlToTargetUrl,
} from './navigation';

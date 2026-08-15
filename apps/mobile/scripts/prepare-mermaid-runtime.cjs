const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const mobileRoot = path.resolve(__dirname, '..');
const outputPath = path.join(mobileRoot, 'assets/generated/mermaid-renderer.html');
const mermaidPackagePath = require.resolve('mermaid/package.json', { paths: [mobileRoot] });
const mermaidRuntimePath = require.resolve('mermaid/dist/mermaid.min.js', {
  paths: [mobileRoot],
});
const mermaidVersion = JSON.parse(readFileSync(mermaidPackagePath, 'utf8')).version;
const mermaidRuntime = readFileSync(mermaidRuntimePath, 'utf8').replace(
  /<\/script/giu,
  '<\\/script',
);
const runtimeHash = createHash('sha256').update(mermaidRuntime).digest('hex');

const harness = String.raw`
(() => {
  'use strict';

  const MAX_SOURCE_BYTES = 65536;
  const MAX_SVG_BYTES = 2097152;
  const viewport = document.getElementById('viewport');
  const stage = document.getElementById('stage');
  const diagram = document.getElementById('diagram');
  const pointers = new Map();
  let activeRequestId = null;
  let mode = 'host';
  let diagramWidth = 1;
  let diagramHeight = 1;
  let fitScale = 1;
  let zoom = 1;
  let translateX = 0;
  let translateY = 0;
  let panOrigin = null;
  let pinchOrigin = null;

  function send(payload) {
    const serialized = JSON.stringify(payload);
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(serialized);
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(serialized, '*');
    }
  }

  function normalizeError(error) {
    const message =
      error && typeof error.message === 'string'
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Mermaid could not render this diagram.';
    return message.replace(/\s+/gu, ' ').trim().slice(0, 500);
  }

  function parsePayload(raw) {
    if (typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function normalizeCssForInspection(value) {
    return value
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?/giu, (_match, hex) => {
        const codePoint = Number.parseInt(hex, 16);
        if (
          !Number.isFinite(codePoint) ||
          codePoint === 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return '\uFFFD';
        }
        return String.fromCodePoint(codePoint);
      })
      .replace(/\\([^\n\r\f0-9a-f])/giu, '$1')
      .toLowerCase();
  }

  function assertSafeCss(value) {
    const normalized = normalizeCssForInspection(value);
    const withoutLocalReferences = normalized.replace(
      /url\s*\(\s*(?:"#[a-z0-9_.:-]+"|'#[a-z0-9_.:-]+'|#[a-z0-9_.:-]+)\s*\)/giu,
      '',
    );
    if (
      /@import\b|(?:url|(?:-webkit-)?image-set|image|src)\s*\(/iu.test(
        withoutLocalReferences,
      )
    ) {
      throw new Error('This Mermaid diagram contains unsupported external styling.');
    }
    return value;
  }

  function parseSvgMarkup(markup) {
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const elements = Array.from(parsed.body.children);
    if (elements.length !== 1 || elements[0].localName !== 'svg') {
      throw new Error('The rendered diagram is unavailable.');
    }
    return elements[0];
  }

  function sanitizeSvg(svg) {
    svg
      .querySelectorAll('script, iframe, object, embed, foreignObject, audio, video, link')
      .forEach((element) => element.remove());
    [svg, ...Array.from(svg.querySelectorAll('*'))].forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (name.startsWith('on') || name === 'src' || name === 'srcset' || name === 'target') {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (
          (name === 'href' || name === 'xlink:href') &&
          !value.startsWith('#') &&
          !/^data:image\/(?:png|gif|jpe?g|webp);base64,/iu.test(value)
        ) {
          element.removeAttribute(attribute.name);
          continue;
        }
        assertSafeCss(value);
      }
    });
    svg.querySelectorAll('style').forEach((style) => {
      style.textContent = assertSafeCss(style.textContent || '');
    });
    return svg.outerHTML;
  }

  function readSvgSize(svg) {
    const viewBox = svg.viewBox && svg.viewBox.baseVal;
    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
      return { width: viewBox.width, height: viewBox.height };
    }
    const width = Number.parseFloat(svg.getAttribute('width') || '');
    const height = Number.parseFloat(svg.getAttribute('height') || '');
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height };
    }
    try {
      const bounds = svg.getBBox();
      if (bounds.width > 0 && bounds.height > 0) {
        return { width: bounds.width, height: bounds.height };
      }
    } catch {
      // Some WebKit builds do not expose a bounding box until the next frame.
    }
    return { width: 800, height: 450 };
  }

  function emitViewState() {
    if (!activeRequestId || mode !== 'viewer') return;
    send({ type: 'viewState', id: activeRequestId, zoom });
  }

  function clampTranslation() {
    const viewportWidth = Math.max(viewport.clientWidth, 1);
    const viewportHeight = Math.max(viewport.clientHeight, 1);
    const renderedWidth = diagramWidth * fitScale * zoom;
    const renderedHeight = diagramHeight * fitScale * zoom;
    const padding = 16;

    if (renderedWidth <= viewportWidth - padding * 2) {
      translateX = (viewportWidth - renderedWidth) / 2;
    } else {
      translateX = Math.min(
        padding,
        Math.max(viewportWidth - renderedWidth - padding, translateX),
      );
    }
    if (renderedHeight <= viewportHeight - padding * 2) {
      translateY = (viewportHeight - renderedHeight) / 2;
    } else {
      translateY = Math.min(
        padding,
        Math.max(viewportHeight - renderedHeight - padding, translateY),
      );
    }
  }

  function paintTransform() {
    if (mode !== 'viewer') {
      stage.style.width = '100%';
      stage.style.height = '100%';
      stage.style.transform = 'none';
      return;
    }
    stage.style.width = diagramWidth + 'px';
    stage.style.height = diagramHeight + 'px';
    stage.style.transform =
      'translate3d(' +
      translateX +
      'px,' +
      translateY +
      'px,0) scale(' +
      fitScale * zoom +
      ')';
  }

  function resetView(shouldEmit = true) {
    const viewportWidth = Math.max(viewport.clientWidth, 1);
    const viewportHeight = Math.max(viewport.clientHeight, 1);
    fitScale = Math.min(
      Math.max((viewportWidth - 32) / diagramWidth, 0.01),
      Math.max((viewportHeight - 32) / diagramHeight, 0.01),
    );
    zoom = 1;
    translateX = (viewportWidth - diagramWidth * fitScale) / 2;
    translateY = (viewportHeight - diagramHeight * fitScale) / 2;
    paintTransform();
    if (shouldEmit) emitViewState();
  }

  function setZoom(nextZoom, focalX, focalY) {
    if (mode !== 'viewer') return;
    const bounded = Math.min(5, Math.max(1, nextZoom));
    const oldScale = fitScale * zoom;
    const nextScale = fitScale * bounded;
    const focusX = Number.isFinite(focalX) ? focalX : viewport.clientWidth / 2;
    const focusY = Number.isFinite(focalY) ? focalY : viewport.clientHeight / 2;
    const contentX = (focusX - translateX) / oldScale;
    const contentY = (focusY - translateY) / oldScale;
    zoom = bounded;
    translateX = focusX - contentX * nextScale;
    translateY = focusY - contentY * nextScale;
    clampTranslation();
    paintTransform();
    emitViewState();
  }

  async function render(payload) {
    if (typeof payload.id !== 'string' || typeof payload.source !== 'string') {
      return;
    }
    activeRequestId = payload.id;
    mode = 'host';
    document.body.dataset.mode = mode;
    diagram.replaceChildren();
    if (new TextEncoder().encode(payload.source).byteLength > MAX_SOURCE_BYTES) {
      send({
        type: 'error',
        id: payload.id,
        message: 'This Mermaid source is too large to render safely.',
      });
      return;
    }

    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: 'base',
        themeVariables:
          payload.theme && typeof payload.theme === 'object' ? payload.theme : undefined,
        htmlLabels: false,
        flowchart: { useMaxWidth: false, htmlLabels: false },
        sequence: { useMaxWidth: false },
      });
      const renderId = 'dappercode-mermaid-' + payload.id.replace(/[^a-zA-Z0-9_-]/gu, '-');
      const result = await mermaid.render(renderId, payload.source);
      if (activeRequestId !== payload.id) return;

      const parsedSvg = parseSvgMarkup(result.svg);
      parsedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      parsedSvg.style.display = 'block';
      parsedSvg.style.width = '100%';
      parsedSvg.style.height = '100%';
      const sanitizedSvg = sanitizeSvg(parsedSvg);
      if (new TextEncoder().encode(sanitizedSvg).byteLength > MAX_SVG_BYTES) {
        throw new Error('This Mermaid diagram is too complex to display safely.');
      }
      diagram.innerHTML = sanitizedSvg;
      const svg = diagram.querySelector('svg');
      if (!svg) throw new Error('Mermaid returned no SVG.');
      const size = readSvgSize(svg);
      diagramWidth = size.width;
      diagramHeight = size.height;
      paintTransform();
      send({
        type: 'rendered',
        id: payload.id,
        width: diagramWidth,
        height: diagramHeight,
        svg: sanitizedSvg,
      });
      emitViewState();
    } catch (error) {
      if (activeRequestId !== payload.id) return;
      diagram.replaceChildren();
      send({ type: 'error', id: payload.id, message: normalizeError(error) });
    }
  }

  function display(payload) {
    if (
      typeof payload.id !== 'string' ||
      typeof payload.svg !== 'string' ||
      !Number.isFinite(payload.width) ||
      payload.width <= 0 ||
      !Number.isFinite(payload.height) ||
      payload.height <= 0
    ) {
      return;
    }
    activeRequestId = payload.id;
    mode = 'viewer';
    document.body.dataset.mode = mode;
    if (new TextEncoder().encode(payload.svg).byteLength > MAX_SVG_BYTES) {
      send({
        type: 'error',
        id: payload.id,
        message: 'This Mermaid diagram is too complex to display safely.',
      });
      return;
    }
    try {
      const sanitizedSvg = sanitizeSvg(parseSvgMarkup(payload.svg));
      diagram.innerHTML = sanitizedSvg;
      const svg = diagram.querySelector('svg');
      if (!svg) {
        throw new Error('The rendered diagram is unavailable.');
      }
      sanitizeSvg(svg);
      diagramWidth = payload.width;
      diagramHeight = payload.height;
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.style.display = 'block';
      svg.style.width = '100%';
      svg.style.height = '100%';
      resetView(false);
      send({ type: 'rendered', id: payload.id, width: diagramWidth, height: diagramHeight });
      emitViewState();
    } catch (error) {
      diagram.replaceChildren();
      send({ type: 'error', id: payload.id, message: normalizeError(error) });
    }
  }

  function handleCommand(raw) {
    const payload = parsePayload(raw);
    if (!payload || typeof payload.type !== 'string') return;
    if (payload.type === 'render') {
      void render(payload);
      return;
    }
    if (payload.type === 'display') {
      display(payload);
      return;
    }
    if (payload.id !== activeRequestId || mode !== 'viewer') return;
    if (payload.type === 'zoomIn') {
      setZoom(zoom * 1.35);
    } else if (payload.type === 'zoomOut') {
      setZoom(zoom / 1.35);
    } else if (payload.type === 'reset') {
      resetView();
    }
  }

  function pointerDistance(first, second) {
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  function pointerMidpoint(first, second) {
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  viewport.addEventListener('pointerdown', (event) => {
    if (mode !== 'viewer') return;
    viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      panOrigin = { x: event.clientX, y: event.clientY, translateX, translateY };
      pinchOrigin = null;
    } else if (pointers.size === 2) {
      const [first, second] = Array.from(pointers.values());
      pinchOrigin = {
        distance: Math.max(pointerDistance(first, second), 1),
        zoom,
      };
      panOrigin = null;
    }
  });

  viewport.addEventListener('pointermove', (event) => {
    if (mode !== 'viewer' || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1 && panOrigin && zoom > 1) {
      translateX = panOrigin.translateX + event.clientX - panOrigin.x;
      translateY = panOrigin.translateY + event.clientY - panOrigin.y;
      clampTranslation();
      paintTransform();
      return;
    }
    if (pointers.size === 2 && pinchOrigin) {
      const [first, second] = Array.from(pointers.values());
      const midpoint = pointerMidpoint(first, second);
      const distance = Math.max(pointerDistance(first, second), 1);
      setZoom(pinchOrigin.zoom * (distance / pinchOrigin.distance), midpoint.x, midpoint.y);
    }
  });

  function finishPointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size === 1) {
      const [remaining] = Array.from(pointers.values());
      panOrigin = {
        x: remaining.x,
        y: remaining.y,
        translateX,
        translateY,
      };
    } else {
      panOrigin = null;
    }
    pinchOrigin = null;
  }

  viewport.addEventListener('pointerup', finishPointer);
  viewport.addEventListener('pointercancel', finishPointer);
  viewport.addEventListener(
    'wheel',
    (event) => {
      if (mode !== 'viewer') return;
      event.preventDefault();
      setZoom(zoom * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    },
    { passive: false },
  );
  viewport.addEventListener('dblclick', (event) => {
    if (mode !== 'viewer') return;
    setZoom(zoom > 1.05 ? 1 : 2, event.clientX, event.clientY);
  });
  window.addEventListener('resize', () => {
    if (mode === 'viewer' && activeRequestId) resetView();
  });
  window.addEventListener('message', (event) => handleCommand(event.data));
  document.addEventListener('message', (event) => handleCommand(event.data));
  send({ type: 'ready' });
})();
`;

const document = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<!-- dappercode-mermaid-runtime ${mermaidVersion} ${runtimeHash} -->
<style>
html, body, #viewport {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-user-select: none;
  user-select: none;
}
#viewport {
  position: relative;
}
#stage {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  will-change: transform;
}
#diagram {
  width: 100%;
  height: 100%;
}
body[data-mode="viewer"] #viewport {
  touch-action: none;
  cursor: grab;
}
body[data-mode="viewer"] #viewport:active {
  cursor: grabbing;
}
</style>
</head>
<body data-mode="host">
<div id="viewport"><div id="stage"><div id="diagram"></div></div></div>
<script>${mermaidRuntime}</script>
<script>${harness}</script>
</body>
</html>
`;

const checkOnly = process.argv.includes('--check');
const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null;
if (checkOnly) {
  if (current !== document) {
    console.error(
      'Mermaid runtime asset is missing or stale. Run: npm run mermaid:prepare -w @dappercode/mobile',
    );
    process.exit(1);
  }
  console.log(`Mermaid runtime ${mermaidVersion} is current.`);
  process.exit(0);
}

if (current !== document) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, document);
  console.log(`Prepared Mermaid runtime ${mermaidVersion}.`);
} else {
  console.log(`Mermaid runtime ${mermaidVersion} is already current.`);
}

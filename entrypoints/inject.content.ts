import {
  multiWindowManager,
  normalizeCropRect,
  type LayoutMode,
  type ManagerSnapshot,
  type NormalizedCropRect,
} from '../utils/multiWindowManager';

type ArmedMode = 'multi' | 'crop';

const DEFAULT_CROP: NormalizedCropRect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

const LAYOUTS: { mode: LayoutMode; label: string; rects: SvgRect[] }[] = [
  {
    mode: 'focus',
    label: 'Focus',
    rects: [{ x: '4', y: '5', width: '16', height: '14', rx: '2', fill: 'none' }],
  },
  {
    mode: 'pip',
    label: 'PiP',
    rects: [
      { x: '3', y: '4', width: '18', height: '16', rx: '2', fill: 'none' },
      { x: '12', y: '12', width: '7', height: '6', rx: '1', fill: 'currentColor' },
    ],
  },
  {
    mode: 'split',
    label: 'Side-by-Side',
    rects: [
      { x: '3', y: '5', width: '8', height: '14', rx: '1.5', fill: 'none' },
      { x: '13', y: '5', width: '8', height: '14', rx: '1.5', fill: 'none' },
    ],
  },
];

interface SvgRect {
  x: string;
  y: string;
  width: string;
  height: string;
  rx: string;
  fill: string;
}

let readyHost: HTMLElement | null = null;
let sessionLive = false;
let detachWatch: (() => void) | null = null;
let unsubscribe: (() => void) | null = null;
let toolbarHost: HTMLElement | null = null;
let cropHost: HTMLElement | null = null;
let nextHost: HTMLElement | null = null;
let armed: ArmedMode | null = null;
let armTimer = 0;

export default defineContentScript({
  matches: ['https://meet.google.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    installDisplayMediaPatch();
  },
});

declare global {
  interface Window {
    __sharemeePatched?: boolean;
  }
}

function installDisplayMediaPatch(): void {
  if (window.__sharemeePatched) return;
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.getDisplayMedia) return;

  window.__sharemeePatched = true;
  const original = mediaDevices.getDisplayMedia.bind(mediaDevices);
  multiWindowManager.useOriginalDisplayMedia(original);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('click', onFollowUpClick, true);
  if (isTopWindow()) showReadyBar();

  // Call the real picker immediately, inside Meet's click. Chrome's dialog
  // can highlight only one window; more windows are added after it closes.
  mediaDevices.getDisplayMedia = (constraints) => {
    const mode = takeArmedMode() ?? 'multi';
    const includeAudio = constraints?.audio !== false;
    const starting = !multiWindowManager.isActive();
    if (starting) {
      multiWindowManager.setIncludeAudio(includeAudio);
      multiWindowManager.primeAudio();
      multiWindowManager.setCropRect(mode === 'crop' ? DEFAULT_CROP : null);
    }

    return original(constraints).then(async (stream) => {
      await multiWindowManager.addCapturedStream(stream);
      const output = multiWindowManager.getOutputStream();
      if (!sessionLive) {
        watchForStopPresenting(output);
        hideReadyBar();
        mountToolbar(mode === 'crop' ? 'crop' : 'multi');
        if (mode === 'crop') openCropEditor();
        else openAddAnother();
      }
      return output;
    }).catch((error: unknown) => {
      if (!multiWindowManager.isActive()) finishSession();
      throw error;
    });
  };
}

let swallowNextClick = false;

function onPointerDown(event: PointerEvent): void {
  if (!event.isTrusted) return;
  if (isOwnUi(event)) {
    armed = null;
    return;
  }
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && multiWindowManager.isActive() && isShareScreenControl(event.target)) {
    swallowNextClick = true;
    event.preventDefault();
    event.stopPropagation();
    void multiWindowManager.addWindowSource().catch((error: unknown) => {
      if (!isUserCancel(error)) console.error(error);
    });
    return;
  }

  window.clearTimeout(armTimer);
  if (!ctrl) {
    armed = null;
    return;
  }
  // Recorded before Meet handles the gesture, so getDisplayMedia still sees Ctrl.
  armed = event.shiftKey ? 'crop' : 'multi';
  armTimer = window.setTimeout(() => {
    armed = null;
  }, 1500);
}

function onFollowUpClick(event: MouseEvent): void {
  if (!swallowNextClick) return;
  swallowNextClick = false;
  event.preventDefault();
  event.stopPropagation();
}

function takeArmedMode(): ArmedMode | null {
  const mode = armed;
  armed = null;
  window.clearTimeout(armTimer);
  return mode;
}

function isTopWindow(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function pageDocument(): Document {
  try {
    if (window.top?.document) return window.top.document;
  } catch {
    // A cross-origin frame cannot use the top document.
  }
  return document;
}

function showReadyBar(): void {
  const mount = (): void => {
    const doc = pageDocument();
    if (doc.getElementById('sharemee-ready')) return;
    const { host, root } = createHost('sharemee-toolbar', false);
    host.id = 'sharemee-ready';
    readyHost = host;
    root.append(styleElement(SHARED_CSS));
    const pill = el('div', 'pill');
    const tag = el('span', 'tag');
    tag.textContent = 'ShareMee';
    const hint = el('span', 'hint');
    hint.textContent = 'Share one window, then add the next from here.';
    pill.append(tag, hint);
    root.append(pill);
  };
  if (pageDocument().body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

function hideReadyBar(): void {
  const doc = pageDocument();
  doc.getElementById('sharemee-ready')?.remove();
  readyHost = null;
}

function isOwnUi(event: Event): boolean {
  return event.composedPath().some((node) =>
    node instanceof HTMLElement &&
    (node.classList.contains('sharemee-toolbar') ||
      node.classList.contains('sharemee-crop') ||
      node.classList.contains('sharemee-next')),
  );
}

function isShareScreenControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('button, [role="button"]');
  if (!(control instanceof Element)) return false;
  const label = controlLabel(control);
  if (/stop (presenting|sharing)/i.test(label)) return false;
  return /share screen|share your screen|present now|start presenting/i.test(label);
}

function controlLabel(control: Element): string {
  const text = (control.textContent ?? '').replace(/\s+/g, ' ').trim();
  return [
    control.getAttribute('aria-label'),
    control.getAttribute('data-tooltip'),
    text.length > 0 && text.length < 48 ? text : '',
  ].filter(Boolean).join(' ');
}

function watchForStopPresenting(stream: MediaStream): void {
  sessionLive = true;
  const onEnded = (): void => finishSession();
  const onClick = (event: MouseEvent): void => {
    if (isStopPresentingControl(event.target)) finishSession();
  };
  for (const track of stream.getTracks()) track.addEventListener('ended', onEnded);
  document.addEventListener('click', onClick, true);
  detachWatch = () => {
    document.removeEventListener('click', onClick, true);
    for (const track of stream.getTracks()) track.removeEventListener('ended', onEnded);
  };
}

function finishSession(): void {
  const hadSession = sessionLive || toolbarHost !== null || cropHost !== null || nextHost !== null;
  sessionLive = false;
  detachWatch?.();
  detachWatch = null;
  unsubscribe?.();
  unsubscribe = null;
  toolbarHost?.remove();
  toolbarHost = null;
  nextHost?.remove();
  nextHost = null;
  closeCropEditor();
  if (hadSession || multiWindowManager.isActive()) multiWindowManager.stopAll();
  else {
    multiWindowManager.setCropRect(null);
    multiWindowManager.releaseIdleAudio();
  }
  if (isTopWindow()) showReadyBar();
}

function isStopPresentingControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('button, [role="button"]');
  if (!(control instanceof Element)) return false;
  const label = `${control.getAttribute('aria-label') ?? ''} ${control.getAttribute('data-tooltip') ?? ''}`;
  return /stop (presenting|sharing)/i.test(label);
}

function mountToolbar(kind: 'multi' | 'crop'): void {
  toolbarHost?.remove();
  unsubscribe?.();

  const { host, root } = createHost('sharemee-toolbar', false);
  pin(host, '12px', '50%', 'translateX(-50%)');
  toolbarHost = host;
  root.append(styleElement(SHARED_CSS));

  const pill = el('div', 'pill');
  pill.setAttribute('role', 'toolbar');
  pill.setAttribute('aria-label', kind === 'crop' ? 'Region crop' : 'Share multiple windows');
  const grip = el('div', 'grip');
  grip.title = 'Drag';
  grip.setAttribute('aria-hidden', 'true');
  for (let dot = 0; dot < 6; dot += 1) grip.append(el('i'));

  if (kind === 'crop') {
    const tag = el('span', 'tag');
    tag.textContent = 'Region crop';
    const edit = el('button', 'layout') as HTMLButtonElement;
    edit.type = 'button';
    edit.textContent = 'Edit crop';
    edit.addEventListener('click', () => openCropEditor());
    pill.append(grip, tag, edit);
    root.append(pill);
    enableDrag(host, pill);
    return;
  }

  const windows = el('div', 'windows');
  const add = el('button', 'add') as HTMLButtonElement;
  add.type = 'button';
  add.textContent = 'Add another window';
  add.title = 'Opens the picker again. Chrome allows one window each time.';
  let adding = false;
  add.addEventListener('click', () => {
    if (adding) return;
    adding = true;
    add.disabled = true;
    void multiWindowManager
      .addWindowSource()
      .catch((error: unknown) => {
        if (!isUserCancel(error)) console.error(error);
      })
      .finally(() => {
        adding = false;
        add.disabled = false;
      });
  });

  const separator = el('div', 'sep');
  const layouts = el('div', 'layouts');
  const layoutButtons = new Map<LayoutMode, HTMLButtonElement>();
  for (const layout of LAYOUTS) {
    const button = el('button', 'layout') as HTMLButtonElement;
    button.type = 'button';
    button.append(svgIcon(layout.rects), pageDocument().createTextNode(layout.label));
    button.addEventListener('click', () => multiWindowManager.setLayoutMode(layout.mode));
    layoutButtons.set(layout.mode, button);
    layouts.append(button);
  }

  pill.append(grip, windows, add, separator, layouts);
  root.append(pill);
  enableDrag(host, pill);

  const render = (snapshot: ManagerSnapshot): void => {
    windows.replaceChildren();
    if (snapshot.sources.length === 0) {
      const hint = el('span', 'hint');
      hint.textContent = 'No windows';
      windows.append(hint);
    }
    for (const source of snapshot.sources) {
      const chip = el('span', 'chip');
      if (source.id === snapshot.activeSourceId) chip.dataset.active = 'true';
      if (!source.included) chip.dataset.included = 'false';
      const name = el('button', 'name') as HTMLButtonElement;
      name.type = 'button';
      name.textContent = source.label;
      name.title = 'Click to focus. Ctrl+click to show or hide.';
      name.setAttribute('aria-pressed', source.id === snapshot.activeSourceId ? 'true' : 'false');
      name.addEventListener('click', (event) => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          multiWindowManager.toggleIncluded(source.id);
          return;
        }
        multiWindowManager.setActiveSource(source.id);
      });

      const remove = el('button', 'remove') as HTMLButtonElement;
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${source.label}`);
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        multiWindowManager.removeWindowSource(source.id);
      });
      chip.append(name, remove);
      windows.append(chip);
    }
    for (const [mode, button] of layoutButtons) {
      const selected = snapshot.layoutMode === mode && snapshot.cropRect === null;
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  };

  unsubscribe = multiWindowManager.onChange(render);
}

function openAddAnother(): void {
  nextHost?.remove();
  const { host, root } = createHost('sharemee-next', false);
  pin(host, '64px', '50%', 'translateX(-50%)');
  nextHost = host;
  root.append(styleElement(SHARED_CSS));

  const card = el('div', 'card next-card');
  const title = el('div', 'card-title');
  title.textContent = 'Add the next window';
  const detail = el('p', 'subtitle');
  detail.textContent = 'That picker can highlight only one window. Choose the next one, then click Share again.';

  const choose = el('button', 'layout') as HTMLButtonElement;
  choose.type = 'button';
  choose.textContent = 'Choose another window';
  let picking = false;
  choose.addEventListener('click', () => {
    if (picking) return;
    picking = true;
    choose.disabled = true;
    void multiWindowManager.addWindowSource().then(
      () => {
        picking = false;
        choose.disabled = false;
        detail.textContent = 'Added. Choose another, or click Done.';
      },
      (error: unknown) => {
        picking = false;
        choose.disabled = false;
        if (!isUserCancel(error)) console.error(error);
      },
    );
  });

  const done = el('button', 'text-button') as HTMLButtonElement;
  done.type = 'button';
  done.textContent = 'Done';
  done.addEventListener('click', () => {
    host.remove();
    if (nextHost === host) nextHost = null;
  });

  const actions = el('div', 'card-actions');
  actions.append(choose, done);
  card.append(title, detail, actions);
  root.append(card);
}

function openCropEditor(): void {
  const stream = multiWindowManager.getActiveStream();
  if (!stream) return;
  closeCropEditor();

  const { host, root } = createHost('sharemee-crop', false);
  pin(host, '64px', '50%', 'translateX(-50%)');
  cropHost = host;
  root.append(styleElement(SHARED_CSS));

  const card = el('div', 'card');
  const header = el('div', 'card-header');
  const heading = el('div', 'card-title');
  heading.textContent = 'Region crop';
  const actions = el('div', 'card-actions');
  const full = el('button', 'text-button') as HTMLButtonElement;
  full.type = 'button';
  full.textContent = 'Full frame';
  const done = el('button', 'layout') as HTMLButtonElement;
  done.type = 'button';
  done.textContent = 'Done';
  done.addEventListener('click', () => closeCropEditor());
  actions.append(full, done);
  header.append(heading, actions);

  const stage = el('div', 'stage');
  const video = pageDocument().createElement('video');
  video.className = 'preview';
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  const fitStage = (): void => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    }
  };
  video.addEventListener('loadedmetadata', fitStage);
  void video.play().then(fitStage).catch(() => undefined);

  const selection = el('div', 'selection');
  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
    const node = el('div', `handle ${handle}`);
    node.dataset.handle = handle;
    selection.append(node);
  }

  let rect = multiWindowManager.getSnapshot().cropRect ?? DEFAULT_CROP;
  const paint = (): void => {
    const next = normalizeCropRect(rect);
    rect = next;
    selection.style.left = `${next.x * 100}%`;
    selection.style.top = `${next.y * 100}%`;
    selection.style.width = `${next.width * 100}%`;
    selection.style.height = `${next.height * 100}%`;
    multiWindowManager.setCropRect(next);
  };
  full.addEventListener('click', () => {
    rect = { x: 0, y: 0, width: 1, height: 1 };
    paint();
  });

  stage.append(video, selection);
  card.append(header, stage);
  root.append(card);
  paint();
  enableDrag(host, header);
  enableCropDrag(stage, selection, () => rect, (next) => {
    rect = next;
    paint();
  });
}

function closeCropEditor(): void {
  const video = cropHost?.shadowRoot?.querySelector('video');
  if (video instanceof HTMLVideoElement) {
    video.pause();
    video.srcObject = null;
  }
  cropHost?.remove();
  cropHost = null;
}

function enableCropDrag(
  stage: HTMLElement,
  selection: HTMLElement,
  getRect: () => NormalizedCropRect,
  setRect: (rect: NormalizedCropRect) => void,
): void {
  stage.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const handle = target.dataset.handle;
    const onSelection = target === selection || handle !== undefined;
    if (!onSelection) return;
    event.preventDefault();
    event.stopPropagation();
    stage.setPointerCapture(event.pointerId);

    const bounds = stage.getBoundingClientRect();
    const origin = { ...getRect() };
    const startX = event.clientX;
    const startY = event.clientY;
    const mode = handle ?? 'move';

    const move = (ev: PointerEvent): void => {
      const dx = bounds.width === 0 ? 0 : (ev.clientX - startX) / bounds.width;
      const dy = bounds.height === 0 ? 0 : (ev.clientY - startY) / bounds.height;
      setRect(applyCropDrag(mode, origin, dx, dy));
    };
    const up = (): void => {
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', up);
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
  });
}

function applyCropDrag(
  mode: string,
  origin: NormalizedCropRect,
  dx: number,
  dy: number,
): NormalizedCropRect {
  let { x, y, width, height } = origin;
  if (mode === 'move') {
    return { x: x + dx, y: y + dy, width, height };
  }
  const west = mode === 'w' || mode === 'nw' || mode === 'sw';
  const east = mode === 'e' || mode === 'ne' || mode === 'se';
  const north = mode === 'n' || mode === 'nw' || mode === 'ne';
  const south = mode === 's' || mode === 'sw' || mode === 'se';
  if (west) {
    x += dx;
    width -= dx;
  }
  if (east) width += dx;
  if (north) {
    y += dy;
    height -= dy;
  }
  if (south) height += dy;
  return { x, y, width, height };
}

function enableDrag(host: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button')) return;

    const rect = host.getBoundingClientRect();
    const originX = event.clientX;
    const originY = event.clientY;
    pin(host, `${rect.top}px`, `${rect.left}px`, 'none');
    handle.setPointerCapture(event.pointerId);

    const move = (ev: PointerEvent): void => {
      const left = clamp(rect.left + ev.clientX - originX, 8, window.innerWidth - 48);
      const top = clamp(rect.top + ev.clientY - originY, 8, window.innerHeight - 48);
      pin(host, `${top}px`, `${left}px`, 'none');
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function createHost(className: string, fullscreen: boolean): { host: HTMLElement; root: ShadowRoot } {
  const doc = pageDocument();
  const host = doc.createElement('div');
  host.className = className;
  host.setAttribute('popover', 'manual');
  const place = (property: string, value: string): void => {
    host.style.setProperty(property, value, 'important');
  };
  place('position', 'fixed');
  place('z-index', '2147483647');
  place('display', 'block');
  place('margin', '0');
  place('padding', '0');
  place('border', '0');
  place('background', 'transparent');
  place('color', '#f4f6fb');
  place('width', fullscreen ? '100vw' : 'max-content');
  place('max-width', 'calc(100vw - 24px)');
  place('height', fullscreen ? '100vh' : 'auto');
  place('inset', 'auto');
  place('right', 'auto');
  place('bottom', 'auto');
  if (fullscreen) {
    place('top', '0');
    place('left', '0');
  } else {
    place('top', '12px');
    place('left', '50%');
    place('transform', 'translateX(-50%)');
  }
  const root = host.attachShadow({ mode: 'open' });
  (doc.body ?? doc.documentElement).appendChild(host);
  try {
    host.showPopover();
  } catch {
    // The top layer is unavailable. The fixed element is still in the page.
  }
  return { host, root };
}

function pin(host: HTMLElement, top: string, left: string, transform: string): void {
  host.style.setProperty('top', top, 'important');
  host.style.setProperty('left', left, 'important');
  host.style.setProperty('right', 'auto', 'important');
  host.style.setProperty('bottom', 'auto', 'important');
  host.style.setProperty('transform', transform, 'important');
}

function styleElement(css: string): HTMLStyleElement {
  const style = pageDocument().createElement('style');
  style.textContent = css;
  return style;
}

function svgIcon(rects: SvgRect[]): SVGSVGElement {
  const doc = pageDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('aria-hidden', 'true');
  for (const rect of rects) {
    const node = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    node.setAttribute('x', rect.x);
    node.setAttribute('y', rect.y);
    node.setAttribute('width', rect.width);
    node.setAttribute('height', rect.height);
    node.setAttribute('rx', rect.rx);
    node.setAttribute('fill', rect.fill);
    if (rect.fill === 'none') {
      node.setAttribute('stroke', 'currentColor');
      node.setAttribute('stroke-width', '1.8');
    }
    svg.append(node);
  }
  return svg;
}

function el(tag: string, className?: string): HTMLElement {
  const node = pageDocument().createElement(tag);
  if (className) node.className = className;
  return node;
}

function isUserCancel(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const SHARED_CSS = `
  :host { color-scheme: dark; }
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; background: transparent; border: 0; padding: 0; cursor: pointer; }
  button:focus-visible { outline: 2px solid #9db7ff; outline-offset: 2px; }
  .overlay {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(8, 10, 14, 0.46);
    font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  }
  .dialog, .card, .pill {
    color: #f4f6fb;
    background: rgba(22, 24, 31, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.38);
  }
  .dialog { width: min(380px, calc(100vw - 32px)); border-radius: 16px; padding: 16px; }
  .title { margin: 0 0 4px; font-size: 16px; font-weight: 650; }
  .subtitle { margin: 0 0 12px; color: #b7beca; font-size: 13px; }
  .choices { display: flex; flex-direction: column; gap: 8px; }
  .choice, .layout, .add, .name, .text-button {
    border-radius: 12px;
  }
  .choice {
    text-align: left;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .choice:hover, .layout:hover, .add:hover, .name:hover { background: rgba(255, 255, 255, 0.08); }
  .choice strong { display: block; font-size: 14px; font-weight: 650; }
  .choice span { display: block; color: #b7beca; font-size: 12px; margin-top: 2px; }
  .text-button { color: #c5cad6; padding: 8px 10px; }
  .pill {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px;
    border-radius: 999px;
    backdrop-filter: blur(12px);
    font: 13px/1.2 ui-sans-serif, system-ui, sans-serif;
    user-select: none;
    cursor: grab;
  }
  .pill:active { cursor: grabbing; }
  .grip {
    width: 18px;
    height: 22px;
    margin: 0 2px;
    display: grid;
    grid-template-columns: repeat(2, 3px);
    grid-auto-rows: 3px;
    gap: 3px;
    align-content: center;
    justify-content: center;
    flex: none;
  }
  .grip i { width: 3px; height: 3px; border-radius: 50%; background: #c5cad6; display: block; }
  .windows {
    display: flex;
    gap: 4px;
    max-width: min(520px, 52vw);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .windows::-webkit-scrollbar { display: none; }
  .chip {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    flex: none;
  }
  .chip[data-active="true"] { background: #2f6fed; }
  .chip[data-included="false"] { opacity: 0.45; }
  .chip[data-included="false"] .name { text-decoration: line-through; }
  .name {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 6px 4px 6px 10px;
  }
  .remove {
    width: 22px;
    height: 22px;
    margin-right: 4px;
    border-radius: 50%;
    color: inherit;
    opacity: 0.8;
  }
  .remove:hover { opacity: 1; background: rgba(0, 0, 0, 0.18); }
  .add, .layout, .tag {
    padding: 6px 10px;
    white-space: nowrap;
  }
  .add { background: rgba(255, 255, 255, 0.06); }
  .layout, .add { display: inline-flex; align-items: center; gap: 6px; }
  .layout[aria-pressed="true"] { background: #2f6fed; }
  .sep { width: 1px; align-self: stretch; background: rgba(255, 255, 255, 0.14); margin: 4px 2px; }
  .hint, .tag { color: #d5dae4; padding: 6px 8px; }
  .layouts { display: flex; gap: 4px; }
  .card {
    width: min(760px, calc(100vw - 32px));
    border-radius: 16px;
    padding: 12px;
    font: 13px/1.3 ui-sans-serif, system-ui, sans-serif;
  }
  .next-card { width: min(420px, calc(100vw - 32px)); }
  .next-card .subtitle { margin: 8px 0 12px; color: #b7beca; }
  .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; cursor: grab; }
  .card-title { font-weight: 650; }
  .card-actions { display: flex; align-items: center; gap: 4px; }
  .stage {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
    border-radius: 10px;
    overflow: hidden;
    touch-action: none;
  }
  .preview { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; }
  .selection {
    position: absolute;
    border: 2px solid #8eb0ff;
    background: rgba(47, 111, 237, 0.18);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
    cursor: move;
  }
  .handle {
    position: absolute;
    width: 10px;
    height: 10px;
    background: #ffffff;
    border: 1px solid #2f6fed;
    border-radius: 2px;
  }
  .handle.nw { top: -5px; left: -5px; cursor: nwse-resize; }
  .handle.ne { top: -5px; right: -5px; cursor: nesw-resize; }
  .handle.sw { bottom: -5px; left: -5px; cursor: nesw-resize; }
  .handle.se { bottom: -5px; right: -5px; cursor: nwse-resize; }
  .handle.n { top: -5px; left: calc(50% - 5px); cursor: ns-resize; }
  .handle.s { bottom: -5px; left: calc(50% - 5px); cursor: ns-resize; }
  .handle.e { right: -5px; top: calc(50% - 5px); cursor: ew-resize; }
  .handle.w { left: -5px; top: calc(50% - 5px); cursor: ew-resize; }
`;

/**
 * Composites an allowlist of user-picked application windows onto one
 * 1920×1080 canvas and exposes that canvas as a single MediaStream.
 *
 * The draw clock is a Web Worker timer (~33ms). requestAnimationFrame is
 * paused while Google Meet is minimized; a worker interval is not tied to
 * the page's render lifecycle. If the page CSP refuses a blob worker, the
 * content script's extension worker posts ticks under FRAME_CLOCK_SOURCE.
 */

export const FRAME_CLOCK_SOURCE = 'sharemee-frame-clock';

export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;

const FRAME_INTERVAL_MS = 33;
const CANVAS_BACKGROUND = '#12141a';
const PIP_SCALE = 0.25;
const PIP_MARGIN = 32;
const PIP_BORDER = 4;
const SPLIT_PAD = 20;
const SPLIT_GAP = 16;
const CROP_MIN = 0.08;

export type LayoutMode = 'focus' | 'pip' | 'split';

export interface SharedWindowInfo {
  id: string;
  label: string;
  /** Ctrl+click hides a window without dropping its capture. */
  included: boolean;
}

/** Crop rectangle in normalized video coordinates (0–1). */
export interface NormalizedCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ManagerSnapshot {
  sources: SharedWindowInfo[];
  layoutMode: LayoutMode;
  activeSourceId: string | null;
  cropRect: NormalizedCropRect | null;
  active: boolean;
}

export type DisplayMediaRequest = (
  constraints?: DisplayMediaStreamOptions,
) => Promise<MediaStream>;

type SnapshotListener = (snapshot: ManagerSnapshot) => void;

interface ActiveWindowSource {
  id: string;
  label: string;
  stream: MediaStream;
  video: HTMLVideoElement;
  videoTrack: MediaStreamTrack;
  audioNode: MediaStreamAudioSourceNode | null;
  included: boolean;
}

interface FrameClockMessage {
  source: typeof FRAME_CLOCK_SOURCE;
  type: 'start' | 'stop' | 'tick';
  interval?: number;
}

const WORKER_SCRIPT = `
let timer = 0;
self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'start') {
    const interval = Number(data.interval) || ${FRAME_INTERVAL_MS};
    if (timer) clearInterval(timer);
    timer = setInterval(() => self.postMessage({ type: 'tick' }), interval);
  } else if (data.type === 'stop') {
    if (timer) clearInterval(timer);
    timer = 0;
  }
};
`;

/**
 * Clamps a crop rectangle so it stays inside the frame and keeps a minimum size.
 * Exported so the on-page selection box matches the pixels drawn to the canvas.
 */
export function normalizeCropRect(rect: NormalizedCropRect): NormalizedCropRect {
  let { x, y, width, height } = rect;
  width = clamp(width, CROP_MIN, 1);
  height = clamp(height, CROP_MIN, 1);
  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  if (x + width > 1) width = 1 - x;
  if (y + height > 1) height = 1 - y;
  width = clamp(width, CROP_MIN, 1);
  height = clamp(height, CROP_MIN, 1);
  x = clamp(x, 0, 1 - width);
  y = clamp(y, 0, 1 - height);
  return { x, y, width, height };
}

export class MultiWindowManager {
  /** Windows the user has allowed, in the order they were added. */
  private sources: ActiveWindowSource[] = [];
  private layoutMode: LayoutMode = 'focus';
  private activeSourceId: string | null = null;
  private cropRect: NormalizedCropRect | null = null;
  private includeAudio = true;
  private started = false;
  private stopping = false;

  private requestDisplay: DisplayMediaRequest = async () => {
    throw new Error('Screen capture is not available in this context.');
  };

  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private canvasStream: MediaStream | null = null;
  private outputStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private audioDestination: MediaStreamAudioDestinationNode | null = null;
  private clock: WorkerFrameClock | null = null;
  private listeners = new Set<SnapshotListener>();

  constructor() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getDisplayMedia) {
      this.requestDisplay = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    }
  }

  /**
   * Use the unpatched getDisplayMedia. Required once the page function is
   * wrapped, so picking another window does not reopen this extension's dialog.
   */
  useOriginalDisplayMedia(request: DisplayMediaRequest): void {
    this.requestDisplay = request;
  }

  isActive(): boolean {
    return this.started;
  }

  setIncludeAudio(enabled: boolean): void {
    if (this.started) return;
    this.includeAudio = enabled;
  }

  /** Create the mixing context during the click that starts a share. */
  primeAudio(): void {
    if (this.started || !this.includeAudio || this.audioContext) return;
    try {
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.audioContext = context;
      this.audioDestination = context.createMediaStreamDestination();
      void context.resume();
    } catch {
      this.includeAudio = false;
      this.audioContext = null;
      this.audioDestination = null;
    }
  }

  /**
   * Prompt for one application window and append it to the allowlist.
   * Returns the updated list of shared windows.
   */
  async addWindowSource(): Promise<SharedWindowInfo[]> {
    const stream = await this.requestDisplay({ video: true, audio: true });
    return this.addCapturedStream(stream);
  }

  /** Attach a stream that getDisplayMedia already returned. */
  async addCapturedStream(stream: MediaStream): Promise<SharedWindowInfo[]> {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stopTracks(stream);
      throw new Error('The selected window did not include a video track.');
    }

    const video = createHiddenVideo(stream);
    try {
      await video.play();
      this.ensureSession();
    } catch (error) {
      video.remove();
      stopTracks(stream);
      throw error;
    }

    const id = createId();
    const source: ActiveWindowSource = {
      id,
      label: readTrackLabel(videoTrack, `Window ${this.sources.length + 1}`),
      stream,
      video,
      videoTrack,
      audioNode: null,
      included: true,
    };
    videoTrack.onended = () => {
      this.removeWindowSource(id);
    };

    this.sources.push(source);
    this.connectAudio(source);
    if (!this.activeSourceId) this.activeSourceId = id;
    this.emit();
    return this.listSources();
  }

  /**
   * Drop one allowlisted window without ending the outgoing Meet stream.
   * Returns the updated list.
   */
  removeWindowSource(id: string): SharedWindowInfo[] {
    const index = this.sources.findIndex((source) => source.id === id);
    if (index === -1) return this.listSources();

    const [source] = this.sources.splice(index, 1);
    this.releaseSource(source);
    if (this.activeSourceId === id) {
      this.activeSourceId = this.sources[0]?.id ?? null;
    }
    this.emit();
    return this.listSources();
  }

  /** Switch Focus / PiP / Side-by-Side while the call is live. */
  setLayoutMode(mode: LayoutMode): void {
    if (mode !== 'focus' && mode !== 'pip' && mode !== 'split') return;
    this.layoutMode = mode;
    this.cropRect = null;
    this.emit();
  }

  getLayoutMode(): LayoutMode {
    return this.layoutMode;
  }

  /** Window drawn full-frame in Focus, and used as the primary pane in PiP. */
  setActiveSource(id: string): void {
    const source = this.sources.find((item) => item.id === id);
    if (!source) return;
    source.included = true;
    this.activeSourceId = id;
    this.emit();
  }

  /** Show or hide one captured window in the composite. The capture stays open. */
  toggleIncluded(id: string): void {
    const source = this.sources.find((item) => item.id === id);
    if (!source) return;
    source.included = !source.included;
    const visible = this.layoutSources();
    if (!visible.some((item) => item.id === this.activeSourceId)) {
      this.activeSourceId = visible[0]?.id ?? null;
    }
    this.emit();
  }

  /**
   * When set, the active window is cropped with drawImage instead of a layout.
   * Pass null to return to Focus / PiP / Side-by-Side.
   */
  setCropRect(rect: NormalizedCropRect | null): void {
    this.cropRect = rect ? normalizeCropRect(rect) : null;
  }

  getOutputStream(): MediaStream {
    if (!this.outputStream) {
      throw new Error('No shared windows are active.');
    }
    return this.outputStream;
  }

  getActiveStream(): MediaStream | null {
    return this.findActive()?.stream ?? null;
  }

  onChange(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ManagerSnapshot {
    return {
      sources: this.listSources(),
      layoutMode: this.layoutMode,
      activeSourceId: this.activeSourceId,
      cropRect: this.cropRect ? { ...this.cropRect } : null,
      active: this.started,
    };
  }

  /** Stop every window track, the worker clock, and the audio context. */
  stopAll(): void {
    if (this.stopping) return;
    this.stopping = true;
    try {
      const sources = [...this.sources];
      this.sources = [];
      for (const source of sources) this.releaseSource(source);

      this.clock?.stop();
      this.clock = null;

      stopTracks(this.outputStream);
      stopTracks(this.canvasStream);
      this.canvas?.remove();
      this.closeAudio();

      this.canvas = null;
      this.context = null;
      this.canvasStream = null;
      this.outputStream = null;
      this.activeSourceId = null;
      this.cropRect = null;
      this.layoutMode = 'focus';
      this.includeAudio = true;
      this.started = false;
      this.emit();
    } finally {
      this.stopping = false;
    }
  }

  releaseIdleAudio(): void {
    if (this.started) return;
    this.closeAudio();
  }

  private listSources(): SharedWindowInfo[] {
    return this.sources.map((source) => ({
      id: source.id,
      label: source.label,
      included: source.included,
    }));
  }

  private layoutSources(): ActiveWindowSource[] {
    const included = this.sources.filter((source) => source.included);
    return included.length > 0 ? included : this.sources;
  }

  private ensureSession(): void {
    if (this.started) return;

    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_WIDTH;
    canvas.height = OUTPUT_HEIGHT;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = [
      'position:fixed',
      'left:-10000px',
      'top:0',
      `width:${OUTPUT_WIDTH}px`,
      `height:${OUTPUT_HEIGHT}px`,
      'pointer-events:none',
    ].join(';');
    (document.body ?? document.documentElement).appendChild(canvas);

    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context) {
      canvas.remove();
      throw new Error('Could not create the shared canvas.');
    }

    const canvasStream = canvas.captureStream(30);
    const videoTrack = canvasStream.getVideoTracks()[0];
    if (videoTrack) videoTrack.contentHint = 'detail';

    this.canvas = canvas;
    this.context = context;
    this.canvasStream = canvasStream;
    this.outputStream = this.buildOutputStream(canvasStream);
    this.started = true;

    this.clock = new WorkerFrameClock(() => {
      try {
        this.drawFrame();
      } catch {
        // A single bad frame should not stop the share.
      }
    });
    this.clock.start();
    this.drawFrame();
  }

  private buildOutputStream(canvasStream: MediaStream): MediaStream {
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];
    if (this.includeAudio && this.audioDestination) {
      tracks.push(...this.audioDestination.stream.getAudioTracks());
    }
    return new MediaStream(tracks);
  }

  private connectAudio(source: ActiveWindowSource): void {
    const audioTracks = source.stream.getAudioTracks();
    if (!this.audioContext || !this.audioDestination || audioTracks.length === 0) return;
    const node = this.audioContext.createMediaStreamSource(new MediaStream(audioTracks));
    node.connect(this.audioDestination);
    source.audioNode = node;
    void this.audioContext.resume();
  }

  private drawFrame(): void {
    const context = this.context;
    if (!context) return;

    context.fillStyle = CANVAS_BACKGROUND;
    context.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    const sources = this.layoutSources();
    if (sources.length === 0) return;

    if (this.cropRect) {
      const source = sources.find((item) => item.id === this.activeSourceId) ?? sources[0];
      drawCropped(context, source.video, this.cropRect);
      return;
    }

    if (this.layoutMode === 'pip') {
      this.drawPip(context, sources);
      return;
    }
    if (this.layoutMode === 'split') {
      this.drawSplit(context, sources);
      return;
    }
    this.drawFocus(context, sources);
  }

  private drawFocus(context: CanvasRenderingContext2D, sources: ActiveWindowSource[]): void {
    const source = sources.find((item) => item.id === this.activeSourceId) ?? sources[0];
    if (!source) return;
    drawContained(context, source.video, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
  }

  private drawPip(context: CanvasRenderingContext2D, sources: ActiveWindowSource[]): void {
    const primary = sources.find((item) => item.id === this.activeSourceId) ?? sources[0];
    if (!primary) return;
    drawContained(context, primary.video, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

    const secondary = nextSource(sources, primary);
    if (!secondary) return;

    const boxW = OUTPUT_WIDTH * PIP_SCALE;
    const boxH = OUTPUT_HEIGHT * PIP_SCALE;
    const x = OUTPUT_WIDTH - PIP_MARGIN - boxW;
    const y = OUTPUT_HEIGHT - PIP_MARGIN - boxH;

    context.save();
    context.shadowColor = 'rgba(0, 0, 0, 0.45)';
    context.shadowBlur = 24;
    context.shadowOffsetY = 10;
    context.fillStyle = '#000000';
    context.fillRect(x, y, boxW, boxH);
    context.restore();

    drawContained(
      context,
      secondary.video,
      x + PIP_BORDER,
      y + PIP_BORDER,
      boxW - PIP_BORDER * 2,
      boxH - PIP_BORDER * 2,
    );
    context.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    context.lineWidth = PIP_BORDER;
    context.strokeRect(x + PIP_BORDER / 2, y + PIP_BORDER / 2, boxW - PIP_BORDER, boxH - PIP_BORDER);
    drawLabel(context, secondary.label, x + 12, y + 12);
  }

  private drawSplit(context: CanvasRenderingContext2D, sources: ActiveWindowSource[]): void {
    const count = sources.length;
    const { cols, rows } = gridSize(count);
    sources.forEach((source, index) => {
      const cell = cellRect(index, count, cols, rows);
      drawContained(context, source.video, cell.x, cell.y, cell.w, cell.h);
      drawLabel(context, source.label, cell.x + 12, cell.y + 12);
    });
  }

  private findActive(): ActiveWindowSource | undefined {
    return this.sources.find((source) => source.id === this.activeSourceId);
  }

  private releaseSource(source: ActiveWindowSource): void {
    source.videoTrack.onended = null;
    source.audioNode?.disconnect();
    source.video.pause();
    source.video.srcObject = null;
    source.video.remove();
    stopTracks(source.stream);
  }

  private closeAudio(): void {
    const context = this.audioContext;
    this.audioContext = null;
    this.audioDestination = null;
    if (context && context.state !== 'closed') void context.close();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

class WorkerFrameClock {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private fallbackId: number | null = null;
  private watchdogId: number | null = null;
  private usingExternalTicks = false;
  private running = false;
  private sawTick = false;
  private lastDraw = 0;

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (!isFrameClockTick(event.data)) return;
    if (!this.usingExternalTicks) {
      this.usingExternalTicks = true;
      this.clearFallback();
    }
    this.tick();
  };

  constructor(private readonly onTick: () => void) {}

  start(): void {
    this.stop();
    this.running = true;
    this.sawTick = false;
    window.addEventListener('message', this.onMessage);
    // Meet requires TrustedScript. A blob worker is blocked there, so the
    // extension worker in the content script drives the frames instead.
    if (!pageRequiresTrustedTypes() && this.tryBlobWorker()) return;
    this.requestExternalClock();
    this.startFallback();
  }

  stop(): void {
    this.running = false;
    window.removeEventListener('message', this.onMessage);
    this.clearWatchdog();
    this.worker?.postMessage({ type: 'stop' });
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    this.clearFallback();
    this.usingExternalTicks = false;
    postClock({ source: FRAME_CLOCK_SOURCE, type: 'stop' });
  }

  private tryBlobWorker(): boolean {
    try {
      const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      this.workerUrl = url;
      this.worker = worker;
      worker.onmessage = () => this.tick();
      worker.onerror = () => {
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        if (this.workerUrl === url) {
          URL.revokeObjectURL(url);
          this.workerUrl = null;
        }
        if (!this.running || this.usingExternalTicks) return;
        this.requestExternalClock();
        this.startFallback();
      };
      worker.postMessage({ type: 'start', interval: FRAME_INTERVAL_MS });
      this.armWatchdog(worker);
      return true;
    } catch {
      if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      this.worker = null;
      return false;
    }
  }

  private requestExternalClock(): void {
    postClock({ source: FRAME_CLOCK_SOURCE, type: 'start', interval: FRAME_INTERVAL_MS });
  }

  private startFallback(): void {
    if (this.fallbackId !== null) return;
    this.fallbackId = window.setInterval(() => this.tick(), FRAME_INTERVAL_MS);
  }

  private clearFallback(): void {
    if (this.fallbackId === null) return;
    window.clearInterval(this.fallbackId);
    this.fallbackId = null;
  }

  private armWatchdog(worker: Worker): void {
    this.clearWatchdog();
    this.watchdogId = window.setTimeout(() => {
      this.watchdogId = null;
      if (!this.running || this.sawTick) return;
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.requestExternalClock();
      this.startFallback();
    }, 250);
  }

  private clearWatchdog(): void {
    if (this.watchdogId === null) return;
    window.clearTimeout(this.watchdogId);
    this.watchdogId = null;
  }

  private tick(): void {
    if (!this.running) return;
    this.sawTick = true;
    const now = performance.now();
    if (now - this.lastDraw < 20) return;
    this.lastDraw = now;
    this.onTick();
  }
}

export const multiWindowManager = new MultiWindowManager();

function createHiddenVideo(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.defaultMuted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.disablePictureInPicture = true;
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  // display:none can stall frame decode. A 2px element still paints for drawImage.
  video.style.cssText = [
    'position:fixed',
    'width:2px',
    'height:2px',
    'left:0',
    'top:0',
    'opacity:0',
    'pointer-events:none',
  ].join(';');
  (document.body ?? document.documentElement).appendChild(video);
  return video;
}

function readTrackLabel(track: MediaStreamTrack, fallback: string): string {
  const label = track.label.trim().replace(/^(window|screen|tab):\s*/i, '');
  return label || fallback;
}

function drawContained(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth === 0 || sourceHeight === 0) return;

  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    video,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function drawCropped(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  rect: NormalizedCropRect,
): void {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth === 0 || sourceHeight === 0) return;

  context.drawImage(
    video,
    rect.x * sourceWidth,
    rect.y * sourceHeight,
    rect.width * sourceWidth,
    rect.height * sourceHeight,
    0,
    0,
    OUTPUT_WIDTH,
    OUTPUT_HEIGHT,
  );
}

function drawLabel(context: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  const label = shorten(text, 32);
  context.save();
  context.font = '600 20px ui-sans-serif, system-ui, sans-serif';
  const width = context.measureText(label).width + 20;
  context.fillStyle = 'rgba(0, 0, 0, 0.55)';
  fillRoundRect(context, x, y, width, 32, 8);
  context.fillStyle = '#ffffff';
  context.textBaseline = 'middle';
  context.fillText(label, x + 10, y + 16);
  context.restore();
}

function fillRoundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, radius);
  } else {
    context.rect(x, y, width, height);
  }
  context.fill();
}

function gridSize(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  const cols = Math.ceil(Math.sqrt(count));
  return { cols, rows: Math.ceil(count / cols) };
}

function cellRect(
  index: number,
  count: number,
  cols: number,
  rows: number,
): { x: number; y: number; w: number; h: number } {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const itemsInRow = Math.min(cols, count - row * cols);
  const gridWidth = OUTPUT_WIDTH - SPLIT_PAD * 2;
  const gridHeight = OUTPUT_HEIGHT - SPLIT_PAD * 2;
  const cellW = (gridWidth - SPLIT_GAP * (cols - 1)) / cols;
  const cellH = (gridHeight - SPLIT_GAP * (rows - 1)) / rows;
  const rowWidth = itemsInRow * cellW + (itemsInRow - 1) * SPLIT_GAP;
  const rowStart = SPLIT_PAD + (gridWidth - rowWidth) / 2;
  return {
    x: rowStart + col * (cellW + SPLIT_GAP),
    y: SPLIT_PAD + row * (cellH + SPLIT_GAP),
    w: cellW,
    h: cellH,
  };
}

function nextSource(
  sources: ActiveWindowSource[],
  primary: ActiveWindowSource,
): ActiveWindowSource | undefined {
  if (sources.length < 2) return undefined;
  const index = sources.findIndex((source) => source.id === primary.id);
  return sources[(index + 1) % sources.length];
}

function shorten(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function pageRequiresTrustedTypes(): boolean {
  return 'trustedTypes' in globalThis;
}

function postClock(message: FrameClockMessage): void {
  window.postMessage(message, window.location.origin);
}

function isFrameClockTick(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<FrameClockMessage>;
  return message.source === FRAME_CLOCK_SOURCE && message.type === 'tick';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

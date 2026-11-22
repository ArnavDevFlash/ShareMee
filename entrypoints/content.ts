import { browser } from 'wxt/browser';

/** Must match FRAME_CLOCK_SOURCE in utils/multiWindowManager.ts */
const FRAME_CLOCK_SOURCE = 'sharemee-frame-clock';

export default defineContentScript({
  matches: ['https://meet.google.com/*'],
  runAt: 'document_start',
  allFrames: true,
  main() {
    bindFrameClockBridge();
  },
});

/**
 * Page CSP on meet.google.com can block the blob worker created in the main
 * world. This isolated-world worker is loaded from the extension package and
 * forwards ticks to the page so the canvas keeps drawing while Meet is in the background.
 */
function bindFrameClockBridge(): void {
  let worker: Worker | null = null;

  const stop = (): void => {
    if (!worker) return;
    worker.postMessage({ type: 'stop' });
    worker.terminate();
    worker = null;
  };

  const start = (interval: number): void => {
    stop();
    try {
      worker = new Worker(browser.runtime.getURL('/frame-clock.js'));
    } catch {
      worker = null;
      return;
    }
    worker.onmessage = () => {
      window.postMessage({ source: FRAME_CLOCK_SOURCE, type: 'tick' }, window.location.origin);
    };
    worker.postMessage({ type: 'start', interval });
  };

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data: unknown = event.data;
    if (!data || typeof data !== 'object') return;
    const message = data as { source?: unknown; type?: unknown; interval?: unknown };
    if (message.source !== FRAME_CLOCK_SOURCE) return;
    if (message.type === 'start') {
      start(typeof message.interval === 'number' ? message.interval : 33);
    } else if (message.type === 'stop') {
      stop();
    }
  });
}

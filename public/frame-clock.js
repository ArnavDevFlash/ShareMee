// Extension-owned frame clock. Used when meet.google.com's CSP blocks a blob worker.
let timer = 0;
self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'start') {
    const interval = Number(data.interval) || 33;
    if (timer) clearInterval(timer);
    timer = setInterval(() => self.postMessage({ type: 'tick' }), interval);
  } else if (data.type === 'stop') {
    if (timer) clearInterval(timer);
    timer = 0;
  }
};

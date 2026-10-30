// Server-sent events from the companion (/studio/events).
// EventSource reconnects by itself; we only track up/down for the offline overlay.

/**
 * @param {{
 *   onUp: () => void,
 *   onDown: () => void,
 *   onStatus: (data: any) => void,
 *   onTarget: (data: any) => void,
 *   onLog?: (data: any) => void
 * }} h
 */
export function connectEvents(h) {
  /** @type {EventSource|null} */
  let es = null;
  let retryTimer = 0;
  let closed = false;

  const parse = (/** @type {MessageEvent} */ ev) => { try { return JSON.parse(ev.data); } catch (e) { return {}; } };

  function open() {
    if (closed) return;
    es = new EventSource('/studio/events');
    es.addEventListener('hello', () => h.onUp());
    es.addEventListener('status', (ev) => h.onStatus(parse(ev)));
    es.addEventListener('target', (ev) => h.onTarget(parse(ev)));
    es.addEventListener('log', (ev) => h.onLog && h.onLog(parse(ev)));
    es.onopen = () => h.onUp();
    es.onerror = () => {
      h.onDown();
      // A 401/500 closes the stream permanently (readyState CLOSED); retry ourselves.
      if (es && es.readyState === EventSource.CLOSED) {
        es = null;
        clearTimeout(retryTimer);
        retryTimer = window.setTimeout(open, 2000);
      }
    };
  }
  open();
  return () => { closed = true; clearTimeout(retryTimer); if (es) es.close(); };
}

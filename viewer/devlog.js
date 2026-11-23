// What a page (or a worker) tells the dev server (by request, for debugging): its uncaught errors and rejected
// promises, console.error / console.warn, and devlog(kind, data) — posted to /log, which viewer/serve.sh writes to
// build/log/client.jsonl (and prints the errors in its terminal). With an error goes what the page registered with
// devContext (the game: its save, the fight's seed; the sandbox: its setup), so that the fight can be run again.
// Only against serve.sh: a POST to /log answered 204 turns it on; anywhere else (GitHub Pages, a file) it stays off
// and sends nothing more. Importing it is enough (game.js, sandbox.js, mapsim.js).
const G = globalThis, where = G.location;
const on0 = !!where && /^https?:$/.test(where.protocol) && !/\.github\.io$/.test(where.hostname) && typeof fetch === 'function';
let state = on0 ? 'probe' : 'off';  // probe → on | off
const contexts = [], seen = new Map();
const page = where ? where.pathname + where.search : '';
const who = typeof document === 'undefined' ? 'worker' : 'page';
const URL_ = on0 ? new URL('/log', where.origin).href : '';
// (the console's own, not the wrapped ones: a failed post never logs itself)
const quiet = { error: G.console?.error?.bind(G.console), warn: G.console?.warn?.bind(G.console) };

// JSON of anything, in time as its size: an object met again (a back-reference, or one shared: a unit's target)
// stands as '[seen]' — not written out again, which on a graph of shared parts (a three.js scene) grows without end
// and hung the page — a typed array as its kind and length, a function as '[fn]', a DOM node or three.js object as
// its kind; past LIMIT characters the rest as '[…]'
const LIMIT = 4 << 20;
export function safeJson(x) {
  const seen = new WeakSet();
  let n = 0;
  return JSON.stringify(x, function (k, v) {
    if (typeof v === 'function') return '[fn]';
    if (typeof v === 'string') n += v.length;
    if (!v || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${v.length}]`;
    if (v.isObject3D || v.isMaterial || v.isTexture || v.isBufferGeometry || (typeof Node === 'function' && v instanceof Node)) return `[${v.constructor?.name || 'object'}]`;
    if (seen.has(v)) return '[seen]';
    seen.add(v);
    if ((n += 8) > LIMIT) return '[…]';
    return v;
  });
}
function post(rec) {
  let body;
  try { body = safeJson(rec); } catch (e) { body = JSON.stringify({ ...rec, data: undefined, context: undefined, unsent: String(e) }); }
  return fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60000 })
    .then(r => r.status === 204, () => false);
}
// (not held back for the probe's answer: that comes on the page's own thread, which may hang before it does — a POST
// to a server without /log is only a 404)
function send(rec) {
  if (state === 'off') return;
  post({ at: new Date().toISOString(), who, page, ...rec });
}
if (on0) post({ at: new Date().toISOString(), who, page, kind: 'hello', ua: G.navigator?.userAgent }).then(ok => { state = ok ? 'on' : 'off'; });

// what to send with an error: fn() → anything JSON can hold (called then; a throw in it is sent in its place)
export function devContext(name, fn) { contexts.push([name, fn]); }
function context() {
  const out = {};
  for (const [name, fn] of contexts) {
    try { out[name] = JSON.parse(safeJson(fn() ?? null)); } catch (e) { out[name] = { contextError: String(e && e.stack || e) }; }
  }
  return out;
}
// a log of one's own: devlog('fight', { t, ... })
export function devlog(kind, data) { send({ kind, data }); }
// the same, sent before it returns (a synchronous request, on a page's thread): for what must be in before the page
// may hang (by request, the fight's start); a worker's, as devlog
export function devlogNow(kind, data) {
  if (state === 'off') return;
  if (typeof XMLHttpRequest !== 'function' || who !== 'page') return devlog(kind, data);
  try {
    const x = new XMLHttpRequest();
    x.open('POST', URL_, false);
    x.setRequestHeader('content-type', 'application/json');
    x.send(safeJson({ at: new Date().toISOString(), who, page, kind, data }));
  } catch (e) { devlog(kind, data); }
}
export const devOn = () => state !== 'off';

const text = x => x instanceof Error ? (x.stack || String(x)) : typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })();
// an error: each different one (its message and first stack line) sent the first 5 times, with the context the
// first time; after that only counted, its count sent with the next of them past every 100th
function error(kind, msg, stack) {
  if (state === 'off') return;
  const key = msg + '\n' + (stack || '').split('\n').find(l => /:\d+:\d+/.test(l));
  const n = (seen.get(key) || 0) + 1;
  seen.set(key, n);
  if (n > 5 && n % 100) return;
  send({ kind, msg, stack, n, ...(n === 1 && { context: context() }) });
}
if (on0) {
  G.addEventListener?.('error', e => error('error', e.message || String(e), e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`));
  G.addEventListener?.('unhandledrejection', e => error('rejection', text(e.reason).split('\n')[0], e.reason?.stack || ''));
  for (const lv of ['error', 'warn']) if (quiet[lv]) G.console[lv] = (...args) => {
    quiet[lv](...args);
    if (lv === 'error') error('console.error', args.map(text).join(' ').slice(0, 2000), new Error().stack);
    else send({ kind: 'console.warn', msg: args.map(text).join(' ').slice(0, 2000) });
  };
}
// a worker this page started: its errors (which the page's own handlers do not see) sent as the page's
export function watchWorker(w, name) {
  if (!on0 || !w) return w;
  w.addEventListener('error', e => error('worker error', `${name}: ${e.message}`, `${e.filename}:${e.lineno}:${e.colno}`));
  w.addEventListener('messageerror', () => error('worker messageerror', name, ''));
  return w;
}

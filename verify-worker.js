// End-to-end check of the service worker fixes: the real content.js in fake LinkedIn tabs sends
// its messages to the real background.js (plus detect.js / wait.js when present), which loads a
// fake Transformers.js. One fake clock, one fake chrome.storage.session that outlives restarts.
// Plain Node 20.19+ / 22.7+, no dependencies, made-up text only.
// Usage: node verify-worker.js /workspace/ai-content-toggle
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { pathToFileURL } = require("url");
const proj = path.resolve(process.argv[2] || ".");

const FAKE_LIB = `
export const fake = { imageDown: false, textDown: false, dead: new Set(), imageLoads: 0, imageLoadTimes: [], fetches: 0 };
export const env = { backends: { onnx: { wasm: {} } } };
export const AutoTokenizer = { from_pretrained: async () => { if (fake.textDown) throw new Error("made up: text download failed"); return (t) => ({ t }); } };
export const AutoModelForSequenceClassification = { from_pretrained: async () => async () => ({ logits: { data: [0, 1] } }) };
export const AutoProcessor = { from_pretrained: async () => {
  fake.imageLoads++; fake.imageLoadTimes.push(Math.round(Date.now() / 1000));
  if (fake.imageDown) throw new Error("made up: image download failed");
  return async (img) => img;
} };
export const AutoModelForImageClassification = { from_pretrained: async () => async () => ({ logits: { data: [2] } }) };
export const RawImage = { fromURL: async (url) => { fake.fetches++; if (fake.dead.has(url) || !globalThis.navigator.onLine) throw new Error("made up: fetch failed"); return { url }; } };
`;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const flush = () => new Promise((r) => setTimeout(r, 1));
const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
const long = "We spent the made up weekend fixing the garden shed roof and sorting old paint tins in the back. ".repeat(3);
const media = (id) => `https://media.licdn.com/dms/image/v2/made-up-${id}/feedshare-shrink_800/0/1`;

let tmp, fake, loads = 0;

// One browser: clock, session storage and onChanged listeners outlive the worker.
function browser() {
  const b = { now: 1_000_000, data: {}, workerListeners: [], tabListeners: [], badge: 0, send: null };
  Date.now = () => b.now;
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
  Object.assign(fake, { imageDown: false, textDown: false, dead: new Set(), imageLoads: 0, imageLoadTimes: [], fetches: 0 });
  const fire = (changes, area) => b.workerListeners.forEach((f) => f(changes, area));
  b.session = {
    async get(k) { return k in b.data ? { [k]: structuredClone(b.data[k]) } : {}; },
    async set(o) { const c = {}; for (const [k, v] of Object.entries(o)) { c[k] = { newValue: v }; b.data[k] = structuredClone(v); } queueMicrotask(() => fire(c, "session")); },
    async remove(k) { if (!(k in b.data)) return; delete b.data[k]; queueMicrotask(() => fire({ [k]: {} }, "session")); },
  };
  // Start (or restart) the worker: a fresh copy of background.js with no models loaded.
  b.start = async () => {
    b.workerListeners = [];
    let listener; const noop = { addListener() {} };
    globalThis.chrome = {
      runtime: { getURL: (p) => p, getPlatformInfo() {}, onMessage: { addListener: (f) => (listener = f) }, onStartup: noop, onInstalled: noop },
      storage: { local: { get: async () => ({ hideAI: true }) }, session: b.session, onChanged: { addListener: (f) => b.workerListeners.push(f) } },
      action: { setBadgeText: () => b.badge++ },
    };
    console.warn = () => {};
    await import(`${pathToFileURL(path.join(tmp, "background.js"))}?w=${++loads}`);
    b.send = (m) => new Promise((r) => listener(m, {}, r));
  };
  // The popup flipping a switch: storage.local change seen by the worker and every tab.
  b.flip = async (key) => { fire({ [key]: { newValue: true } }, "local"); b.tabListeners.forEach((f) => f({ [key]: { newValue: true } }, "local")); await settle(); };
  b.tabs = [];
  b.tab = (posts) => {
    let tick, pending = null; const watching = new Set();
    const ctx = {
      console: { log() {}, warn() {} }, setTimeout, setInterval: (fn) => ((tick = fn), 1), clearInterval() {},
      document: { querySelectorAll: () => posts, documentElement: { classList: { toggle() {} } }, addEventListener() {} },
      IntersectionObserver: class {
        constructor(cb) { this.cb = cb; }
        observe(t) {
          if (watching.has(t)) return; watching.add(t);
          if (!pending) setTimeout(() => { const e = pending.filter((x) => watching.has(x)).map((x) => ({ target: x, isIntersecting: true })); pending = null; if (e.length) this.cb(e); }, 0);
          (pending ??= []).push(t);
        }
        unobserve(t) { watching.delete(t); } disconnect() { watching.clear(); }
      },
      chrome: { runtime: { id: "x", sendMessage: (m) => (t.sent++, b.send(m)), onMessage: { addListener() {} } }, storage: { local: { get: async () => ({ hideAI: true }) }, onChanged: { addListener: (f) => b.tabListeners.push(f) } } },
      __now: () => b.now,
    };
    const t = { posts, sent: 0, tick: () => tick && tick() };
    vm.createContext(ctx);
    vm.runInContext("Date.now = () => __now();", ctx);
    for (const f of ["style.js", "rules.js", "content.js"]) vm.runInContext(fs.readFileSync(path.join(proj, f), "utf8"), ctx, { filename: f });
    b.tabs.push(t);
    return t;
  };
  b.run = async (seconds) => { for (let i = 0; i < seconds; i++) { b.now += 1000; b.tabs.forEach((t) => t.tick()); await settle(); } };
  return b;
}
function post({ text = "", images = [] }) {
  const p = { dataset: {} };
  p.querySelectorAll = (sel) => (sel === "img" ? images.map((src) => ({ src })) : sel.includes("expandable") && text ? [{ innerText: text, closest: () => null }] : []);
  Object.defineProperty(p, "textContent", { get: () => text || "Made Up Name" });
  return p;
}
const state = (p) => `${p.dataset.ai}${p.dataset.aiScore ? " " + p.dataset.aiScore : ""}`;

(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-worker-"));
  fs.mkdirSync(path.join(tmp, "lib"));
  fs.writeFileSync(path.join(tmp, "lib", "transformers.min.js"), FAKE_LIB);
  fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
  for (const f of ["background.js", "detect.js", "wait.js"]) if (fs.existsSync(path.join(proj, f))) fs.copyFileSync(path.join(proj, f), path.join(tmp, f));
  ({ fake } = await import(pathToFileURL(path.join(tmp, "lib", "transformers.min.js"))));

  try {
    // 1. Image-only post while the image model download fails, then it works again.
    {
      const b = browser(); await b.start(); fake.imageDown = true;
      const p = post({ images: [media(1)] }); b.tab([p]); await settle();
      const during = state(p);
      await b.run(5); fake.imageDown = false; await b.run(30);
      check("image model down: an image-only post is retried, not written off", during === "error" && p.dataset.ai === "no" && p.dataset.aiScore === "0.88", `during=${during}, after=${state(p)}`);
    }
    // 2. Image-only post with a dead link: settled once, not retried in a loop.
    {
      const b = browser(); await b.start(); fake.dead.add(media(2));
      const p = post({ images: [media(2)] }); const t = b.tab([p]); await settle(); await b.run(60);
      check("dead image link: the post is settled once, no retry loop", p.dataset.ai === "no" && t.sent === 1, `${state(p)}, messages ${t.sent}`);
    }
    // 3. Text plus a dead image link: the text score decides.
    {
      const b = browser(); await b.start(); fake.dead.add(media(3));
      const p = post({ text: long, images: [media(3)] }); b.tab([p]); await settle(); await b.run(2);
      check("text + dead image link: the text score decides", p.dataset.ai === "no" && p.dataset.aiScore === "0.73", state(p));
    }
    // 4. Three tabs, three image-only posts each, image model down for 120 s.
    {
      const b = browser(); await b.start(); fake.imageDown = true;
      for (const start of [0, 3, 7]) { if (start) await b.run(start - (b.now - 1_000_000) / 1000); b.tab([1, 2, 3].map((k) => post({ images: [media(`t${start}-${k}`)] }))); await settle(); }
      await b.run(120 - (b.now - 1_000_000) / 1000);
      const times = fake.imageLoadTimes.map((s) => s - 1000);
      const perSecond = Math.max(...Object.values(times.reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {})));
      check("three tabs in an outage: at most one download attempt per round", perSecond === 1 && fake.imageLoads <= 5, `attempts ${fake.imageLoads} at ${times.join(", ")} s`);
      check("three tabs in an outage: attempts back off at 0, 10, 30, 70 s", JSON.stringify(times) === "[0,10,30,70]", `at ${times.join(", ")} s`);
    }
    // 5. During an image outage, a text post in another tab is still checked right away.
    {
      const b = browser(); await b.start(); fake.imageDown = true;
      b.tab([post({ images: [media(5)] })]); await settle(); await b.run(15);
      const tp = post({ text: long }); b.tab([tp]); await settle(); await b.run(1);
      check("image outage: a text post in another tab is scored right away", tp.dataset.ai === "no" && tp.dataset.aiScore === "0.73", state(tp));
    }
    // 6. A worker restart during the wait keeps it: no download before the wait ends.
    {
      const b = browser(); await b.start(); fake.imageDown = true;
      const p = post({ images: [media(6)] }); b.tab([p]); await settle();          // attempt 1 at 0 s, wait 10 s
      await b.run(5); await b.start();                                             // Chrome restarts the worker
      await b.flip("someOtherKey");                                                // unrelated change: no reset
      b.tab([post({ images: [media("6b")] })]); await settle(); await b.run(3);   // new tab asks at 5-8 s
      check("worker restart keeps the wait (no attempt before 10 s)", fake.imageLoads === 1, `attempts ${fake.imageLoads} at ${fake.imageLoadTimes.map((s) => s - 1000).join(", ")} s`);
    }
    // 7. Flipping Hide ads during the wait retries right away.
    {
      const b = browser(); await b.start(); fake.imageDown = true;
      const p = post({ images: [media(7)] }); b.tab([p]); await settle(); await b.run(3);
      const before = fake.imageLoads; fake.imageDown = false;
      await b.flip("hideAds"); await b.run(1);
      check("flipping a switch ends the wait: the download is tried right away", before === 1 && fake.imageLoads === 2 && p.dataset.aiScore === "0.88", `attempts ${before} -> ${fake.imageLoads}, post ${state(p)}`);
    }
    // 8. Offline after the models are cached: image posts wait instead of being written off.
    {
      const b = browser(); await b.start();
      b.tab([post({ images: [media("8a")] })]); await settle();                   // the image model loads fine
      navigator.onLine = false;
      const p = post({ images: [media("8b")] }); b.tab([p]); await settle(); await b.run(1);
      const during = state(p);
      navigator.onLine = true; await b.run(40);
      check("offline: an image post is retried after reconnecting, not written off", during === "error" && p.dataset.aiScore === "0.88", `during=${during}, after=${state(p)}`);
    }
    // 9. The badge ignores the worker's own storage writes.
    {
      const b = browser(); await b.start(); fake.imageDown = true;
      b.tab([post({ images: [media(9)] })]); await settle(); await b.run(35);
      const fromWrites = b.badge;
      await b.flip("hideAI");
      check("badge: only switch flips update it, not the worker's own wait writes", fromWrites === 0 && b.badge === 1, `updates from writes ${fromWrites}, after a flip ${b.badge}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  (" + r.detail + ")"}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

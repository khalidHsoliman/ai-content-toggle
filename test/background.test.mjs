// Pins the behaviour of background.js, the service worker: how it loads the models, scores a
// post, and replies to content.js. Run with `node --test` from the repo root.
// The real lib/ (Transformers.js) can't run here, so background.js and detect.js are copied to a
// temporary folder next to a stand-in lib/transformers.min.js; lib/ itself is never touched.
// chrome, navigator and the clock are stand-ins too. All text is made up.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The stand-in Transformers.js. Each model records how it was loaded and what it was given;
// fake.* switches make a download fail or an image link dead. Text P(AI) comes from textLogits
// ([human, ai]), image P(AI) from imageLogit.
const FAKE_LIB = `
export const fake = { calls: [], textOffline: false, imageOffline: false, dead: new Set(),
  textLogits: [0, 0], imageLogit: 0, delay: 0 };
const wait = () => new Promise((r) => setTimeout(r, fake.delay));
const load = (name, kind, opts) => {
  fake.calls.push(["load", name, kind, opts]);
  if (fake[kind === "text" ? "textOffline" : "imageOffline"]) throw new Error("made up: download failed");
};
export const env = { backends: { onnx: { wasm: {} } } };
export const AutoTokenizer = { from_pretrained: async (name) => {
  load("AutoTokenizer", "text", name);
  return (text, opts) => (fake.calls.push(["tokenize", text, opts]), { text });
} };
export const AutoModelForSequenceClassification = { from_pretrained: async (name, opts) => {
  load("AutoModelForSequenceClassification", "text", [name, opts]);
  return async () => (fake.calls.push(["run text"]), await wait(), fake.calls.push(["text done"]), { logits: { data: fake.textLogits } });
} };
export const AutoProcessor = { from_pretrained: async (name) => {
  load("AutoProcessor", "image", name);
  return async (image) => ({ image });
} };
export const AutoModelForImageClassification = { from_pretrained: async (name, opts) => {
  load("AutoModelForImageClassification", "image", [name, opts]);
  return async ({ image }) => (fake.calls.push(["run image", image.url]), await wait(), { logits: { data: [fake.imageLogit] } });
} };
export const RawImage = { fromURL: async (url) => {
  fake.calls.push(["fetch", url]);
  if (fake.dead.has(url)) throw new Error("made up: image fetch failed");
  return { url };
} };
`;

let dir, fake, loads = 0;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "act-background-"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "transformers.min.js"), FAKE_LIB);
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }');
  for (const f of ["background.js", "detect.js", "wait.js"]) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  ({ fake } = await import(pathToFileURL(path.join(dir, "lib", "transformers.min.js"))));
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

// One browser, online, with what outlives the service worker: the clock (Date.now),
// chrome.storage.session, and the storage.onChanged listeners. Like Chrome, session writes fire
// onChanged (area "session"), so the worker hears its own writes. start() starts the worker: a
// fresh copy of background.js with no models loaded, as after Chrome stopped it.
async function browser(t) {
  Object.assign(fake, { calls: [], textOffline: false, imageOffline: false, dead: new Set(), textLogits: [0, 0], imageLogit: 0, delay: 0 });
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
  const b = { now: 1_000_000, listeners: [], data: {}, local: {}, badges: [], warn: t.mock.method(console, "warn", () => {}) };
  t.mock.method(Date, "now", () => b.now);
  const changed = (changes, area) => b.listeners.forEach((f) => f(changes, area));
  b.session = {
    async get(key) {
      return key in b.data ? { [key]: structuredClone(b.data[key]) } : {};
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) (changes[k] = { oldValue: b.data[k], newValue: v }), (b.data[k] = structuredClone(v));
      queueMicrotask(() => changed(changes, "session"));
    },
    async remove(key) {
      if (!(key in b.data)) return;
      const changes = { [key]: { oldValue: b.data[key] } };
      delete b.data[key];
      queueMicrotask(() => changed(changes, "session"));
    },
  };
  b.advance = (ms) => (b.now += ms);
  // The popup writing a switch (or any other key) to storage.local.
  b.flip = (key) => {
    b.local[key] = !b.local[key];
    changed({ [key]: { oldValue: !b.local[key], newValue: b.local[key] } }, "local");
  };
  b.start = async () => {
    b.listeners = []; // a stopped worker's listeners are gone with it
    let listener;
    const noop = { addListener() {} };
    globalThis.chrome = {
      runtime: { getURL: (p) => `chrome-extension://made-up-id/${p}`, getPlatformInfo() {}, onMessage: { addListener: (f) => (listener = f) }, onStartup: noop, onInstalled: noop },
      storage: {
        local: { get: async (keys) => Object.fromEntries(keys.filter((k) => k in b.local).map((k) => [k, b.local[k]])) },
        session: b.session,
        onChanged: { addListener: (f) => b.listeners.push(f) },
      },
      action: { setBadgeText: ({ text }) => b.badges.push(text) },
    };
    await import(`${pathToFileURL(path.join(dir, "background.js"))}?worker=${++loads}`);
    // send(msg) resolves to the reply, like chrome.runtime.sendMessage in content.js.
    const send = (msg) =>
      new Promise((resolve, reject) => {
        const async = listener({ type: "detect", images: [], text: "", ...msg }, {}, resolve);
        if (async !== true) reject(new Error(`listener returned ${async}, not true`));
      });
    return { send, listener };
  };
  return b;
}

// A browser with its worker started.
async function worker(t) {
  const b = await browser(t);
  return { ...(await b.start()), warn: b.warn, browser: b };
}

// How often each model's download has been tried (each try loads the tokenizer or processor).
const downloads = (kind) => fake.calls.filter((c) => c[0] === "load" && c[1] === (kind === "text" ? "AutoTokenizer" : "AutoProcessor")).length;

const text = "A made up post about garden sheds and weekend plans. ".repeat(5);
const P = (logit) => 1 / (1 + Math.exp(-logit)); // sigmoid, like the models' P(AI)

test("background: the ONNX runtime is loaded from the extension's lib/", async (t) => {
  const { env } = await import(pathToFileURL(path.join(dir, "lib", "transformers.min.js")));
  await worker(t);
  assert.deepEqual(env.backends.onnx.wasm.wasmPaths, { wasm: "chrome-extension://made-up-id/lib/ort-wasm-simd-threaded.asyncify.wasm" });
});

test("background: a text post is scored by the text model, loaded as q8, with the text cleaned up", async (t) => {
  const { send } = await worker(t);
  fake.textLogits = [0, 3];
  const raw = "  𝗕𝗼𝗹𝗱 made up\n\nwords  ";
  assert.deepEqual(await send({ text: raw }), { score: P(3), isAI: true, textScore: P(3) });
  assert.deepEqual(fake.calls.filter((c) => c[0] === "load"), [
    ["load", "AutoTokenizer", "text", "MedAliFarhat/ai-text-detector-onnx"],
    ["load", "AutoModelForSequenceClassification", "text", ["MedAliFarhat/ai-text-detector-onnx", { dtype: "q8" }]],
  ]);
  // NFKC turns the bold letters plain, whitespace becomes single spaces; at most 512 tokens.
  assert.deepEqual(fake.calls.find((c) => c[0] === "tokenize"), ["tokenize", "Bold made up words", { truncation: true, max_length: 512 }]);
});

test("background: an image is scored by the image model, loaded as fp32; the models load once", async (t) => {
  const { send } = await worker(t);
  fake.imageLogit = 2;
  assert.deepEqual(await send({ images: ["a.jpg"] }), { score: P(2), isAI: false, textScore: null });
  assert.deepEqual(await send({ images: ["b.jpg"] }), { score: P(2), isAI: false, textScore: null });
  assert.deepEqual(fake.calls.filter((c) => c[0] === "load"), [
    ["load", "AutoProcessor", "image", "buildborderless/CommunityForensics-DeepfakeDet-ViT"],
    ["load", "AutoModelForImageClassification", "image", ["buildborderless/CommunityForensics-DeepfakeDet-ViT", { dtype: "fp32" }]],
  ]);
});

test("background: messages other than detect get no reply", async (t) => {
  const { listener } = await worker(t);
  let replied = false;
  assert.equal(listener({ type: "something else" }, {}, () => (replied = true)), undefined);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(replied, false);
});

test("background: a failed text model download replies null, and after the 10 s wait the download is tried again", async (t) => {
  const { send, browser: b } = await worker(t);
  fake.textOffline = true;
  assert.equal(await send({ text }), null);
  fake.textOffline = false;
  fake.textLogits = [2, 0];
  b.advance(9_999);
  assert.equal(await send({ text }), null); // still waiting: turned away without a download
  assert.equal(downloads("text"), 1);
  b.advance(1);
  assert.deepEqual(await send({ text }), { score: P(-2), isAI: false, textScore: P(-2) });
  assert.equal(downloads("text"), 2);
});

test("background: a failed image model download replies null for an image-only post and for text plus image", async (t) => {
  const { send, browser: b } = await worker(t);
  fake.imageOffline = true;
  fake.textLogits = [0, 3];
  assert.equal(await send({ images: ["a.jpg"] }), null);
  b.advance(10_000); // past the wait, so the download is really tried again
  assert.equal(await send({ text, images: ["a.jpg"] }), null); // even though the text alone is sure
  assert.equal(downloads("image"), 2);
  fake.imageOffline = false;
  b.advance(20_000);
  assert.deepEqual(await send({ images: ["a.jpg"] }), { score: P(0), isAI: false, textScore: null });
});

test("background: a failed image model download is tried once per post, not once per image", async (t) => {
  const { send } = await worker(t);
  fake.imageOffline = true;
  assert.equal(await send({ images: ["a.jpg", "b.jpg", "c.jpg"] }), null);
  assert.equal(fake.calls.filter((c) => c[1] === "AutoProcessor").length, 1);
});

test("background: online, an image that can't be fetched is skipped and the rest decide", async (t) => {
  const { send, warn } = await worker(t);
  fake.dead.add("dead.jpg");
  fake.textLogits = [0, 3];
  fake.imageLogit = 1;
  assert.deepEqual(await send({ text, images: ["dead.jpg"] }), { score: P(3), isAI: true, textScore: P(3) });
  assert.deepEqual(await send({ images: ["dead.jpg", "b.jpg"] }), { score: P(1), isAI: false, textScore: null });
  // Every link dead: not a failure, score 0 like a post with nothing to check.
  assert.deepEqual(await send({ images: ["dead.jpg"] }), { score: 0, isAI: false, textScore: null });
  assert.equal(fake.calls.some((c) => c[0] === "run image" && c[1] === "dead.jpg"), false);
  assert.equal(warn.mock.callCount(), 3); // one warning per skipped image
});

test("background: offline, an image that can't be fetched fails the post (null), so it's retried", async (t) => {
  const { send, browser: b } = await worker(t);
  fake.dead.add("a.jpg");
  fake.textLogits = [0, 3];
  navigator.onLine = false;
  assert.equal(await send({ images: ["a.jpg"] }), null);
  b.advance(10_000); // past the wait, so the image is really fetched again
  assert.equal(await send({ text, images: ["a.jpg"] }), null);
  assert.equal(fake.calls.filter((c) => c[0] === "fetch").length, 2);
  navigator.onLine = true; // back online, the same link is now treated as dead
  b.advance(20_000);
  assert.deepEqual(await send({ images: ["a.jpg"] }), { score: 0, isAI: false, textScore: null });
});

test("background: posts are checked one at a time, in the order they arrive", async (t) => {
  const { send } = await worker(t);
  fake.delay = 5;
  fake.imageOffline = true; // the middle post fails; the queue carries on
  const replies = await Promise.all([send({ text: "first made up post" }), send({ images: ["a.jpg"] }), send({ text: "third made up post" })]);
  assert.deepEqual(replies.map((r) => r && r.textScore), [0.5, null, 0.5]);
  assert.equal(replies[1], null);
  // The third post isn't started until the first has finished.
  assert.deepEqual(fake.calls.filter((c) => ["tokenize", "run text", "text done"].includes(c[0])).map((c) => c[1] ?? c[0]),
    ["first made up post", "run text", "text done", "third made up post", "run text", "text done"]);
});

// ---- The retry wait, shared by all tabs (wait.js, kept in chrome.storage.session) ----

test("background: three tabs during an image outage, one download attempt per round in all", async (t) => {
  const b = await browser(t);
  const { send } = await b.start();
  fake.imageOffline = true;
  // Each tab asks about its two image posts every 5 s, whatever its own wait says.
  const tabs = ["one", "two", "three"].map((tab) => [`${tab}-a.jpg`, `${tab}-b.jpg`]);
  const round = () => Promise.all(tabs.flat().map((url) => send({ images: [url] })));
  const attempts = [];
  for (let s = 0; s <= 145; s += 5) {
    const before = downloads("image");
    const replies = await round();
    assert.ok(replies.every((r) => r === null), `at ${s} s`);
    assert.ok(downloads("image") - before <= 1, `at ${s} s: ${downloads("image") - before} attempts`);
    if (downloads("image") > before) attempts.push(s);
    b.advance(5_000);
  }
  assert.deepEqual(attempts, [0, 10, 30, 70]); // waits of 10, 20, 40 s, then 80 s until 150 s
  fake.imageOffline = false;
  fake.imageLogit = 3;
  const replies = await round(); // 150 s: the download works, every post gets its score
  assert.ok(replies.every((r) => r && r.score === P(3)));
  assert.equal(downloads("image"), 5);
  // The model loaded fine, so its wait is gone: the next failure starts over at 10 s.
  assert.deepEqual(b.data.modelWaits ?? {}, {});
});

test("background: a restarted worker keeps the wait and the failure count", async (t) => {
  const b = await browser(t);
  fake.imageOffline = true;
  assert.equal(await (await b.start()).send({ images: ["a.jpg"] }), null); // fails: wait 10 s
  b.advance(5_000);
  let { send } = await b.start(); // Chrome stopped the worker and started it again
  assert.equal(await send({ images: ["a.jpg"] }), null);
  assert.equal(downloads("image"), 1); // still waiting: not tried
  b.advance(5_000);
  ({ send } = await b.start());
  assert.equal(await send({ images: ["a.jpg"] }), null); // tried, fails again: second round, 20 s
  assert.equal(downloads("image"), 2);
  b.advance(19_999);
  ({ send } = await b.start());
  assert.equal(await send({ images: ["a.jpg"] }), null);
  assert.equal(downloads("image"), 2);
  b.advance(1);
  assert.equal(await send({ images: ["a.jpg"] }), null);
  assert.equal(downloads("image"), 3);
});

test("background: during an image outage text posts go through; text plus image waits without running the text model", async (t) => {
  const { send, browser: b } = await worker(t);
  fake.imageOffline = true;
  fake.textLogits = [0, 3];
  assert.equal(await send({ images: ["a.jpg"] }), null); // the image model is now waiting
  assert.deepEqual(await send({ text }), { score: P(3), isAI: true, textScore: P(3) });
  const withImage = "A second made up post, this one with a photo of a shed. ".repeat(4);
  assert.equal(await send({ text: withImage, images: ["b.jpg"] }), null);
  assert.equal(fake.calls.filter((c) => c[0] === "tokenize").length, 1); // only the text-only post's
  assert.equal(downloads("image"), 1);
  assert.deepEqual(Object.keys(b.data.modelWaits), ["image"]);
});

test("background: flipping Hide AI or Hide ads ends the wait; other storage changes don't", async (t) => {
  const { send, browser: b } = await worker(t);
  fake.imageOffline = true;
  assert.equal(await send({ images: ["a.jpg"] }), null);
  // The worker's own storage.session write has fired onChanged by now; the wait is still there.
  await new Promise((r) => setTimeout(r, 1));
  assert.ok(b.data.modelWaits.image);
  b.flip("someOtherKey");
  assert.equal(await send({ images: ["a.jpg"] }), null);
  assert.equal(downloads("image"), 1); // still waiting
  b.flip("hideAI");
  assert.equal(await send({ images: ["a.jpg"] }), null);
  assert.equal(downloads("image"), 2); // tried right away (and failed again, from 10 s)
  b.flip("hideAds");
  fake.imageOffline = false;
  assert.deepEqual(await send({ images: ["a.jpg"] }), { score: P(0), isAI: false, textScore: null });
  assert.equal(downloads("image"), 3);
});

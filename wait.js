// The wait before a model that failed (download, offline) is tried again, shared by every
// LinkedIn tab: background.js checks it before a post reaches the models, so three open tabs
// don't try a failing download three times as often. One wait per model ("text", "image"), so
// text posts keep going through while only the image model is down.
// Kept in storage (chrome.storage.session in background.js), because Chrome stops an idle
// service worker and it loses its memory; session storage is cleared when the browser restarts.
// Tested with a fake clock and storage in test/wait.test.mjs.

// The same wait as `retry` in rules.js, each tab's own (which a module can't import).
export const RETRY_DELAY = 10_000; // after a failure, wait this long before trying the model again...
export const MAX_RETRY_DELAY = 10 * 60_000; // ...doubling while it keeps failing, up to this

const KEY = "modelWaits"; // { text: { failures, at }, image: { failures, at } }, only models that failed

export function createWaits(storage) {
  const load = async () => (await storage.get(KEY))[KEY] ?? {};
  const save = (waits) => storage.set({ [KEY]: waits });
  return {
    // Whether the model may be tried at this time (Date.now()).
    async ready(model, now) {
      return now >= ((await load())[model]?.at ?? 0);
    },
    // The model failed: wait 10 s, doubling per failed round, up to 10 min. A failure while
    // it's already waiting counts as the same round, like in rules.js.
    async failed(model, now) {
      const waits = await load();
      const { failures = 0, at = 0 } = waits[model] ?? {};
      const count = now >= at ? failures + 1 : failures;
      waits[model] = { failures: count, at: now + Math.min(RETRY_DELAY * 2 ** (count - 1), MAX_RETRY_DELAY) };
      await save(waits);
    },
    // The model loaded and ran: its wait ends and its failures are forgotten.
    async succeeded(model) {
      const waits = await load();
      if (!(model in waits)) return; // nothing to forget: no write
      delete waits[model];
      await save(waits);
    },
    // Every model may be tried right away (the user flipped a switch).
    async reset() {
      await storage.remove(KEY);
    },
  };
}

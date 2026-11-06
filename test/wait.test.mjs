// Pins the behaviour of wait.js, the retry wait the background worker shares between tabs.
// Run with `node --test` from the repo root. The clock is plain numbers (ms), the storage a
// stand-in for chrome.storage.session.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createWaits, RETRY_DELAY, MAX_RETRY_DELAY } from "../wait.js";

// Like chrome.storage.session: values are stored as copies, and writes are counted.
function fakeStorage() {
  const data = {};
  const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    data,
    writes: 0,
    async get(key) {
      return key in data ? { [key]: copy(data[key]) } : {};
    },
    async set(items) {
      this.writes++;
      for (const [k, v] of Object.entries(items)) data[k] = copy(v);
    },
    async remove(key) {
      this.writes++;
      delete data[key];
    },
  };
}

test("wait: the same 10 s and 10 min as the per-tab retry in rules.js", () => {
  const rules = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "rules.js"), "utf8");
  const ctx = vm.createContext({ STYLE_MIN_POINTS: 3 });
  vm.runInContext(rules, ctx);
  assert.equal(RETRY_DELAY, vm.runInContext("RETRY_DELAY", ctx));
  assert.equal(MAX_RETRY_DELAY, vm.runInContext("MAX_RETRY_DELAY", ctx));
  assert.equal(RETRY_DELAY, 10_000);
  assert.equal(MAX_RETRY_DELAY, 600_000);
});

test("wait: nothing waits until a model fails", async () => {
  const waits = createWaits(fakeStorage());
  assert.equal(await waits.ready("text", 0), true);
  assert.equal(await waits.ready("image", 1e12), true);
});

test("wait: after a failure the model waits 10 s, doubling per failed round, up to 10 min", async () => {
  const waits = createWaits(fakeStorage());
  await waits.failed("image", 1000);
  assert.equal(await waits.ready("image", 10_999), false);
  assert.equal(await waits.ready("image", 11_000), true);
  let now = 11_000;
  for (const wait of [20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000]) {
    await waits.failed("image", now);
    assert.equal(await waits.ready("image", now + wait - 1), false, `wait of ${wait}`);
    assert.equal(await waits.ready("image", now + wait), true, `wait of ${wait}`);
    now += wait;
  }
});

test("wait: a failure while the model is already waiting counts as the same round", async () => {
  const waits = createWaits(fakeStorage());
  await waits.failed("image", 0);
  await waits.failed("image", 500); // still in the 10 s wait: not doubled, only moved on
  assert.equal(await waits.ready("image", 10_499), false);
  assert.equal(await waits.ready("image", 10_500), true);
  await waits.failed("image", 10_500); // the next round: 20 s
  assert.equal(await waits.ready("image", 30_499), false);
  assert.equal(await waits.ready("image", 30_500), true);
});

test("wait: one wait per model, a failing image model doesn't hold up the text model", async () => {
  const waits = createWaits(fakeStorage());
  await waits.failed("image", 0);
  assert.equal(await waits.ready("image", 5000), false);
  assert.equal(await waits.ready("text", 5000), true);
});

test("wait: a success ends that model's wait and forgets its failures, not the other model's", async () => {
  const storage = fakeStorage();
  const waits = createWaits(storage);
  await waits.failed("image", 0);
  await waits.failed("image", 10_000); // 20 s wait
  await waits.failed("text", 10_000);
  await waits.succeeded("image");
  assert.equal(await waits.ready("image", 10_001), true);
  assert.equal(await waits.ready("text", 10_001), false);
  await waits.failed("image", 10_001); // starts over at 10 s, not 40 s
  assert.equal(await waits.ready("image", 20_000), false);
  assert.equal(await waits.ready("image", 20_001), true);
});

test("wait: a success with nothing to forget doesn't write to storage", async () => {
  const storage = fakeStorage();
  const waits = createWaits(storage);
  await waits.succeeded("text");
  await waits.succeeded("image");
  assert.equal(storage.writes, 0);
});

test("wait: reset lets every model be tried right away", async () => {
  const waits = createWaits(fakeStorage());
  await waits.failed("text", 0);
  await waits.failed("image", 0);
  await waits.reset();
  assert.equal(await waits.ready("text", 1), true);
  assert.equal(await waits.ready("image", 1), true);
  await waits.failed("image", 1); // and starts over at 10 s
  assert.equal(await waits.ready("image", 10_001), true);
});

test("wait: kept in storage, so a restarted worker (a new createWaits) keeps the wait and the count", async () => {
  const storage = fakeStorage();
  await createWaits(storage).failed("image", 0);
  await createWaits(storage).failed("image", 10_000); // second round: 20 s
  assert.deepEqual(storage.data, { modelWaits: { image: { failures: 2, at: 30_000 } } });
  const restarted = createWaits(storage);
  assert.equal(await restarted.ready("image", 29_999), false);
  await restarted.failed("image", 30_000); // third round: 40 s
  assert.equal(await restarted.ready("image", 69_999), false);
  assert.equal(await restarted.ready("image", 70_000), true);
});

// Pins the behaviour of detect.js, the part of the background worker that turns model scores
// into the reply content.js gets. Run with `node --test` from the repo root.
// The models are stand-ins: functions that return made-up scores or fail like a download would.
// All text is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, THRESHOLD } from "../detect.js";

const text = "A made up post about garden sheds and weekend plans. ".repeat(5);

// Stand-in models. scores maps a text or image URL to its P(AI), to an Error to reject with
// (the model download failed), or, for an image, to DEAD (null: the link can't be fetched).
// calls records what was scored, in order.
function models(scores) {
  const calls = [];
  const score = (kind) => async (input) => {
    calls.push(`${kind}:${input}`);
    const s = scores[input];
    if (s instanceof Error) throw s;
    if (s === undefined) throw new Error(`no stand-in score for ${input}`);
    return s;
  };
  return { textScore: score("text"), imageScore: score("image"), calls };
}

const offline = () => new Error("made up: model download failed");
const DEAD = null; // what background.js's imageScore gives for an image it can't fetch

test("detect: THRESHOLD is 0.9", () => {
  assert.equal(THRESHOLD, 0.9);
});

test("detect: text only, score and textScore are the text model's, isAI from 0.9 up", async () => {
  assert.deepEqual(await detect({ text, images: [] }, models({ [text]: 0.95 })), { score: 0.95, isAI: true, textScore: 0.95 });
  assert.deepEqual(await detect({ text, images: [] }, models({ [text]: 0.9 })), { score: 0.9, isAI: true, textScore: 0.9 });
  assert.deepEqual(await detect({ text, images: [] }, models({ [text]: 0.89 })), { score: 0.89, isAI: false, textScore: 0.89 });
  // A score of 0 is still a text score, not "no text".
  assert.deepEqual(await detect({ text, images: [] }, models({ [text]: 0 })), { score: 0, isAI: false, textScore: 0 });
});

test("detect: the text goes to the text model as sent (background.js does the cleanup)", async () => {
  const m = models({ [text]: 0.2 });
  await detect({ text, images: [] }, m);
  assert.deepEqual(m.calls, [`text:${text}`]);
});

test("detect: no text (\"\") skips the text model, textScore is null", async () => {
  const m = models({ "a.jpg": 0.3 });
  assert.deepEqual(await detect({ text: "", images: ["a.jpg"] }, m), { score: 0.3, isAI: false, textScore: null });
  assert.deepEqual(m.calls, ["image:a.jpg"]);
});

test("detect: image only, score is the highest image score", async () => {
  const m = models({ "a.jpg": 0.2, "b.jpg": 0.93, "c.jpg": 0.5 });
  assert.deepEqual(await detect({ text: "", images: ["a.jpg", "b.jpg", "c.jpg"] }, m), { score: 0.93, isAI: true, textScore: null });
});

test("detect: text and images, score is the highest of all, textScore the text model's alone", async () => {
  assert.deepEqual(await detect({ text, images: ["a.jpg"] }, models({ [text]: 0.6, "a.jpg": 0.95 })), { score: 0.95, isAI: true, textScore: 0.6 });
  assert.deepEqual(await detect({ text, images: ["a.jpg"] }, models({ [text]: 0.7, "a.jpg": 0.1 })), { score: 0.7, isAI: false, textScore: 0.7 });
});

test("detect: scores the text first, then each image in order, one at a time", async () => {
  let running = 0, most = 0;
  const slow = (s) => async () => {
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return s;
  };
  const calls = [];
  const log = (kind, fn) => (input) => (calls.push(`${kind}:${input}`), fn(input));
  await detect({ text, images: ["a.jpg", "b.jpg"] }, { textScore: log("text", slow(0.1)), imageScore: log("image", slow(0.2)) });
  assert.deepEqual(calls, [`text:${text}`, "image:a.jpg", "image:b.jpg"]);
  assert.equal(most, 1);
});

test("detect: no text and no images gives score 0 (content.js doesn't send these)", async () => {
  assert.deepEqual(await detect({ text: "", images: [] }, models({})), { score: 0, isAI: false, textScore: null });
});

test("detect: a failed text model rejects, and the images aren't scored", async () => {
  // background.js replies null to a rejection, so content.js retries the post after the wait.
  const err = offline();
  const m = models({ [text]: err, "a.jpg": 0.95 });
  await assert.rejects(detect({ text, images: ["a.jpg"] }, m), err);
  assert.deepEqual(m.calls, [`text:${text}`]);
});

// ---- A failed model download fails the whole post ----
// detect rejects, background.js replies null, content.js marks the post "error" and tries it
// again after the retry wait, like a failed text check.

test("detect: image-only post whose image model download fails rejects", async () => {
  const err = offline();
  await assert.rejects(detect({ text: "", images: ["a.jpg"] }, models({ "a.jpg": err })), err);
});

test("detect: a failed image model download stops at the first image, the rest aren't tried", async () => {
  const err = offline();
  const m = models({ "a.jpg": 0.3, "b.jpg": err, "c.jpg": 0.95 });
  await assert.rejects(detect({ text: "", images: ["a.jpg", "b.jpg", "c.jpg"] }, m), err);
  assert.deepEqual(m.calls, ["image:a.jpg", "image:b.jpg"]);
});

test("detect: text and image, a failed image model download fails the post even when the text is sure", async () => {
  // The text score is thrown away; the post is checked again, text and all, after the wait.
  for (const textScore of [0.2, 0.6, 0.95]) {
    const err = offline();
    await assert.rejects(detect({ text, images: ["a.jpg"] }, models({ [text]: textScore, "a.jpg": err })), err, `text ${textScore}`);
  }
});

// ---- An image that can't be fetched (dead link) is skipped ----
// The text and the other images decide, and the reply is a normal one: content.js gives the
// post its verdict for good and resets the retry wait.

test("detect: text and a dead image link, the text score decides", async () => {
  assert.deepEqual(await detect({ text, images: ["a.jpg"] }, models({ [text]: 0.6, "a.jpg": DEAD })), { score: 0.6, isAI: false, textScore: 0.6 });
  assert.deepEqual(await detect({ text, images: ["a.jpg"] }, models({ [text]: 0.95, "a.jpg": DEAD })), { score: 0.95, isAI: true, textScore: 0.95 });
});

test("detect: image-only, a dead link is skipped and the other images decide", async () => {
  const m = models({ "a.jpg": DEAD, "b.jpg": 0.92 });
  assert.deepEqual(await detect({ text: "", images: ["a.jpg", "b.jpg"] }, m), { score: 0.92, isAI: true, textScore: null });
  assert.deepEqual(m.calls, ["image:a.jpg", "image:b.jpg"]);
  assert.deepEqual(await detect({ text: "", images: ["a.jpg", "b.jpg"] }, models({ "a.jpg": DEAD, "b.jpg": 0.1 })), { score: 0.1, isAI: false, textScore: null });
});

test("detect: text, a dead link and a working image, the highest of the ones scored", async () => {
  const m = models({ [text]: 0.4, "a.jpg": DEAD, "b.jpg": 0.7 });
  assert.deepEqual(await detect({ text, images: ["a.jpg", "b.jpg"] }, m), { score: 0.7, isAI: false, textScore: 0.4 });
});

test("detect: image-only post with every link dead gets score 0, like a post with nothing to check", async () => {
  // Not a failure: content.js marks it "no" for good (data-ai-score 0.00) and isn't retried.
  const m = models({ "a.jpg": DEAD, "b.jpg": DEAD });
  assert.deepEqual(await detect({ text: "", images: ["a.jpg", "b.jpg"] }, m), { score: 0, isAI: false, textScore: null });
  assert.deepEqual(m.calls, ["image:a.jpg", "image:b.jpg"]);
});

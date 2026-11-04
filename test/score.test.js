// Pins the behaviour of scripts/score.js. Run with `node --test` from the repo root.
// All fixtures are made-up text.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const { score, report } = require("../scripts/score.js");
// score.js ran style.js in this context, so its globals can be read back.
// Weights and the threshold come from style.js, so tuning them doesn't break these tests.
const { STYLE_SIGNALS, STYLE_MIN_POINTS } = vm.runInThisContext("({ STYLE_SIGNALS, STYLE_MIN_POINTS })");
const weight = Object.fromEntries(STYLE_SIGNALS.map(([name, points]) => [name, points]));

const script = path.join(__dirname, "..", "scripts", "score.js");
const sample = path.join(__dirname, "..", "scripts", "sample-posts.txt");
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

// Signals chosen to be clear-cut: markdown flags on its own, a numbered list alone stays under STYLE_MIN_POINTS.
const posts = [
  "AI\n**Bold heading** and here's what I learned about made up widgets.",
  "AI\nA plain made up post about a shed.",
  "Human\nAnother plain made up post about a garden.",
  "Human\nSteps:\n1. dig\n2. plant\n3. water",
].join("\n===\n");

// The table row for one signal, as [points, AI posts, Human posts].
const row = (text, name) =>
  text.split("\n").find((line) => line.startsWith(name + "  ")).slice(name.length).trim().split(/\s{2,}/);

test("score: parses the posts and adds each one's style result", () => {
  const rows = score(posts);
  assert.deepEqual(rows.map((r) => r.label), ["AI", "AI", "Human", "Human"]);
  assert.deepEqual(rows[0].style, { points: weight.markdown + weight["stock phrases"], hits: ["markdown", "stock phrases"] });
  assert.deepEqual(rows[1].style, { points: 0, hits: [] });
  assert.deepEqual(rows[3].style, { points: weight["numbered list"], hits: ["numbered list"] });
});

test("score: Windows line endings score the same as \\n, as in the page's textarea", () => {
  assert.deepEqual(score(posts.replace(/\n/g, "\r\n")), score(posts));
});

test("report: starts with the compare page's style summary", () => {
  const lines = report(score(posts)).split("\n");
  assert.equal(lines[0], "Style rules (the extension flags these without running a model)");
  assert.equal(lines[1], "Catches 1 of 2 AI posts, wrongly flags 0 of 2 human posts");
});

test("report: lists every signal in STYLE_SIGNALS order with how often it fired per label", () => {
  const text = report(score(posts));
  // Signals the fixture hits; every other signal fired in no post.
  // Fired counts include posts that stayed under the threshold (the numbered list).
  const fired = { markdown: ["1 of 2", "0 of 2"], "stock phrases": ["1 of 2", "0 of 2"], "numbered list": ["0 of 2", "1 of 2"] };
  for (const [name, points] of STYLE_SIGNALS) {
    assert.deepEqual(row(text, name), [String(points), ...(fired[name] ?? ["0 of 2", "0 of 2"])], name);
  }
  const order = STYLE_SIGNALS.map(([name]) => text.indexOf("\n" + name + "  "));
  assert.ok(order.every((i) => i > 0), "every signal has a row");
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

// A row as score() returns it, with a made-up style result.
const scored = (label, points, text = `A made up ${label} post.`) => ({ label, text, style: { points, hits: ["made up signal"] } });
const section = (text) => text.slice(text.indexOf("Flagged posts:\n")).split("\n").slice(1);

test("report: a post at exactly STYLE_MIN_POINTS is flagged, one point less isn't", () => {
  const rows = [
    scored("AI", STYLE_MIN_POINTS),
    scored("AI", STYLE_MIN_POINTS - 1),
    scored("Human", STYLE_MIN_POINTS),
    scored("Human", STYLE_MIN_POINTS - 1),
  ];
  const text = report(rows);
  assert.equal(text.split("\n")[1], "Catches 1 of 2 AI posts, wrongly flags 1 of 2 human posts");
  assert.deepEqual(section(text).map((line) => line.split(",")[0]), ["Post 1", "Post 3"]);
  // The same boundary through the real rules, with a post whose only signal is markdown.
  assert.equal(weight.markdown, STYLE_MIN_POINTS, "this check needs markdown to be worth exactly STYLE_MIN_POINTS");
  const real = score("Human\nSome **bold words** in a made up post.\n===\nAI\nA plain made up post.");
  assert.deepEqual(real[0].style, { points: STYLE_MIN_POINTS, hits: ["markdown"] });
  assert.equal(report(real).split("\n")[1], "Catches 0 of 1 AI posts, wrongly flags 1 of 1 human posts");
});

test("report: one line per flagged post, numbered by its place in the file", () => {
  const rows = [
    scored("AI", STYLE_MIN_POINTS - 1),
    scored("Human", STYLE_MIN_POINTS + 1, "First line of a made up post\n\nthat goes on well past the fifty character cut."),
    scored("AI", STYLE_MIN_POINTS, "Short made up post."),
  ];
  rows[1].style.hits = ["em dash", "closing question"];
  assert.deepEqual(section(report(rows)), [
    `Post 2, Human, ${STYLE_MIN_POINTS + 1} points: em dash, closing question. "First line of a made up post that goes on well pas…"`,
    `Post 3, AI, ${STYLE_MIN_POINTS} points: made up signal. "Short made up post."`,
  ]);
});

test("report: says none when no post is flagged", () => {
  assert.deepEqual(section(report([scored("AI", 0), scored("Human", STYLE_MIN_POINTS - 1)])), ["none"]);
});

test("sample file: parses into 5 AI and 5 Human posts", () => {
  const rows = score(fs.readFileSync(sample, "utf8"));
  assert.equal(rows.filter((r) => r.label === "AI").length, 5);
  assert.equal(rows.filter((r) => r.label === "Human").length, 5);
});

test("cli: prints the report for a file", () => {
  const out = run(sample);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, report(score(fs.readFileSync(sample, "utf8"))) + "\n");
});

test("cli: exits with 1 and a message when there's no file, a bad label or no posts", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "score-"));
  const write = (name, text) => (fs.writeFileSync(path.join(tmp, name), text), path.join(tmp, name));
  try {
    for (const [args, message] of [
      [[], /Usage: node scripts\/score\.js/],
      [[path.join(tmp, "missing.txt")], /ENOENT/],
      [[write("bad.txt", "AI\none\n===\nMaybe\ntwo")], /Post 2 doesn't start with a line saying AI or Human\./],
      [[write("empty.txt", "\n===\n")], /No posts in/],
    ]) {
      const out = run(...args);
      assert.equal(out.status, 1, String(args));
      assert.match(out.stderr, message);
      assert.equal(out.stdout, "");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

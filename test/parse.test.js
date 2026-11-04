// Pins the behaviour of parse.js, the labeled-post format shared by compare.js and scripts/score.js.
// Run with `node --test` from the repo root. All fixtures are made-up text.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// parse.js is a plain script (no exports), so run it as one here and read its global back.
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "parse.js"), "utf8"), { filename: "parse.js" });
const parse = vm.runInThisContext("parse");

test("parse: posts split on === lines, each with its label and trimmed text", () => {
  assert.deepEqual(parse("AI\nA made up post.\n===\nHuman\nAnother made up post.\n"), [
    { label: "AI", text: "A made up post." },
    { label: "Human", text: "Another made up post." },
  ]);
});

test("parse: labels are case-insensitive and may have spaces around them", () => {
  assert.deepEqual(
    parse("ai\none\n===\n  HUMAN  \ntwo\n===\nHuMaN\nthree").map((r) => r.label),
    ["AI", "Human", "Human"]
  );
});

test("parse: a post keeps its inner lines and blank lines, only the ends are trimmed", () => {
  assert.deepEqual(parse("Human\n\n  first line\n\nsecond line  \n\n"), [
    { label: "Human", text: "first line\n\nsecond line" },
  ]);
});

test("parse: only a line of exactly === (trailing spaces allowed) separates posts", () => {
  assert.equal(parse("AI\none\n===   \nHuman\ntwo").length, 2);
  // These stay inside the post's text.
  for (const line of ["====", " ===", "=== not alone", "a === b"]) {
    assert.deepEqual(parse(`Human\nbefore\n${line}\nafter`), [{ label: "Human", text: `before\n${line}\nafter` }], line);
  }
});

test("parse: empty input and empty blocks give no posts", () => {
  assert.deepEqual(parse(""), []);
  assert.deepEqual(parse("  \n===\n\n===\n"), []);
  assert.deepEqual(parse("===\nAI\none\n===\n===\nHuman\ntwo\n===").map((r) => r.text), ["one", "two"]);
});

test("parse: a label with no text gives an empty post", () => {
  assert.deepEqual(parse("AI"), [{ label: "AI", text: "" }]);
});

test("parse: a post without an AI or Human line throws, naming the post", () => {
  assert.throws(() => parse("Just some text."), { message: "Post 1 doesn't start with a line saying AI or Human." });
  // Empty blocks aren't counted, so the number matches what the user sees.
  assert.throws(() => parse("AI\none\n===\n===\nAI: two"), { message: "Post 2 doesn't start with a line saying AI or Human." });
  assert.throws(() => parse("Humans\nthree"), /Post 1/);
});

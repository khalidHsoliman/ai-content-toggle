// Pins the current behaviour of style.js. Run with `node --test` from the repo root.
// All fixtures are made-up text.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// style.js is a plain script (no exports), so run it as one here and read its globals back.
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "style.js"), "utf8"), { filename: "style.js" });
const { aiStyle, STYLE_MIN_POINTS } = vm.runInThisContext("({ aiStyle, STYLE_MIN_POINTS })");

// Names and weights of the signals hit by a text.
const hits = (text) => aiStyle(text).hits;

test("a plain post hits nothing", () => {
  assert.deepEqual(aiStyle("We moved the widget factory to a bigger shed last spring and it went fine."), {
    points: 0,
    hits: [],
  });
});

test("markdown: **bold** or a # heading line, worth 3 on its own", () => {
  assert.deepEqual(aiStyle("Some **bold words** in the middle."), { points: 3, hits: ["markdown"] });
  assert.deepEqual(hits("Intro line.\n## A heading\nMore text."), ["markdown"]);
  assert.deepEqual(hits("### Third level"), ["markdown"]);
  assert.deepEqual(hits("#### Four hashes is not a heading"), []);
  assert.deepEqual(hits("#hashtag at line start is not a heading"), []);
  assert.deepEqual(hits("A single *asterisk* pair is not markdown"), []);
});

test("Unicode bold: mathematical bold letters, worth 1", () => {
  assert.deepEqual(aiStyle("Mostly normal text with 𝗼𝗻𝗲 bold word."), { points: 1, hits: ["Unicode bold"] });
});

test("arrow bullets: two or more lines starting with an arrow or emoji, worth 2", () => {
  assert.deepEqual(aiStyle("Intro\n→ first point\n→ second point"), { points: 2, hits: ["arrow bullets"] });
  assert.deepEqual(hits("Intro\n✅ first point\n  👉 indented second point"), ["arrow bullets"]);
  assert.deepEqual(hits("Intro\n• first\n◆ second"), ["arrow bullets"]);
  assert.deepEqual(hits("Intro\n→ only one bullet line"), []);
  assert.deepEqual(hits("Emoji at the end of a line 🎉\nand another 🎉"), []);
});

test("em dash: any em dash, worth 2 (a hyphen or en dash is not)", () => {
  assert.deepEqual(aiStyle("Widgets — the good kind."), { points: 2, hits: ["em dash"] });
  assert.deepEqual(hits("Widgets - the good kind."), []);
  assert.deepEqual(hits("Widgets – the good kind."), []);
});

test("short lines: eight or more lines with more than 75% under 70 characters, worth 1", () => {
  const short = "a short line about widgets";
  const long = "a much longer line about widgets that keeps going well past the seventy character mark";
  const lines = (...ls) => ls.join("\n");
  assert.deepEqual(aiStyle(lines(...Array(8).fill(short))), { points: 1, hits: ["short lines"] });
  assert.deepEqual(hits(lines(...Array(7).fill(short))), []); // seven is not enough
  assert.deepEqual(hits(lines(...Array(7).fill(short), long)), ["short lines"]); // 7/8 = 87.5%
  assert.deepEqual(hits(lines(...Array(6).fill(short), long, long)), []); // 6/8 = 75%, not more
  // Blank lines are ignored when counting.
  assert.deepEqual(hits(lines(...Array(7).fill(short), "", "", "")), []);
});

test("stock phrases: a listed phrase anywhere, case-insensitive, worth 2", () => {
  for (const text of [
    "Here's what nobody tells you about widgets.",
    "Key takeaway: buy more widgets.",
    "The result: more widgets than ever.",
    "Widgets are a game changer for sheds.",
    "Let us delve into widgets.",
    "THRILLED TO ANNOUNCE a new widget.",
    "TL;DR widgets are fine.",
    "This is not just a widget, but a way of life.",
    "Follow me for more widget stories.",
    "Navigating the widget landscape takes patience.",
  ]) {
    assert.deepEqual(aiStyle(text), { points: 2, hits: ["stock phrases"] }, text);
  }
  assert.deepEqual(hits("We are delving into the shed today."), []); // "delve" is matched as a whole word
  assert.deepEqual(hits("Here is what we did."), []); // only the contracted "here's"
});

test("closing question: ends with a question mark (hashtags allowed after), worth 1", () => {
  assert.deepEqual(aiStyle("Which widget would you pick?"), { points: 1, hits: ["closing question"] });
  assert.deepEqual(hits("Which widget would you pick?\n#widgets #sheds"), ["closing question"]);
  assert.deepEqual(hits("Which widget would you pick?  \n"), ["closing question"]); // trailing whitespace
  assert.deepEqual(hits("Which widget would you pick? I chose the blue one."), []);
  // "thoughts?" or "agree?" counts wherever it appears.
  assert.deepEqual(hits("Thoughts? Let me know in the shed."), ["closing question"]);
  assert.deepEqual(hits("Do you agree? Either way, widgets."), ["closing question"]);
});

test("numbered list: three or more lines starting with a number and . or ), worth 1", () => {
  assert.deepEqual(aiStyle("Steps:\n1. open\n2. close\n3. repeat"), { points: 1, hits: ["numbered list"] });
  assert.deepEqual(hits("Steps:\n1) open\n  2) close\n10) repeat"), ["numbered list"]);
  assert.deepEqual(hits("Steps:\n1. open\n2. close"), []); // two is not enough
  assert.deepEqual(hits("Steps:\n1.open\n2.close\n3.repeat"), []); // a space after the number is required
});

test("points add up and hits keep the signal order from STYLE_SIGNALS", () => {
  assert.deepEqual(aiStyle("Widgets — **bold** — delve in.\n1. a\n2. b\n3. c"), {
    points: 3 + 2 + 2 + 1,
    hits: ["markdown", "em dash", "stock phrases", "numbered list"],
  });
});

test("STYLE_MIN_POINTS is 3: markdown alone flags, one weak signal with an em dash flags, an em dash alone doesn't", () => {
  assert.equal(STYLE_MIN_POINTS, 3);
  assert.ok(aiStyle("Some **bold words**.").points >= STYLE_MIN_POINTS);
  assert.ok(aiStyle("Widgets — are they worth it?").points >= STYLE_MIN_POINTS); // em dash + closing question
  assert.ok(aiStyle("Widgets — the good kind.").points < STYLE_MIN_POINTS);
  assert.ok(aiStyle("Thoughts?").points < STYLE_MIN_POINTS);
});

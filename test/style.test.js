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
  assert.deepEqual(hits("Intro\n► first\n◆ second"), ["arrow bullets"]);
  assert.deepEqual(hits("Intro\n✔️ first\n📌 second\n🔹 third"), ["arrow bullets"]);
  assert.deepEqual(hits("Intro\n→ only one bullet line"), []);
  assert.deepEqual(hits("Emoji at the end of a line 🎉\nand another 🎉"), []);
});

test("arrow bullets: plain • dots, ▪ ▫ squares and © ® ™ lines are not bullets", () => {
  assert.deepEqual(hits("Shopping list:\n• eggs\n• flour\n• made up jam"), []);
  // Each symbol on its own, so dropping any one from the exclusion fails here.
  assert.deepEqual(hits("Shopping list:\n▪ eggs\n▪ flour"), []);
  assert.deepEqual(hits("Shopping list:\n▫ eggs\n▫ flour"), []);
  assert.deepEqual(hits("© one made up credit\n© another"), []);
  assert.deepEqual(hits("® one made up mark\n® another"), []);
  assert.deepEqual(hits("™ one made up mark\n™ another"), []);
  assert.deepEqual(hits("© Made up studio, all rights reserved\n® A made up registered name"), []);
  // With the emoji variation selector (U+FE0F) they're still not bullets.
  assert.deepEqual(hits("©\uFE0F made up credit\n®\uFE0F made up mark"), []);
  assert.deepEqual(hits("▪\uFE0F eggs\n▫\uFE0F flour"), []);
  // They don't count towards real bullets either: one emoji line plus a dot line is one bullet.
  assert.deepEqual(hits("Intro\n✅ a real bullet\n• a plain dot\n© a made up credit"), []);
  assert.deepEqual(hits("Intro\n✅ first\n• plain dot\n👉 second"), ["arrow bullets"]);
});

test("em dash: any em dash, worth 1 however many there are (a hyphen or en dash is not)", () => {
  // Only 1 point: plenty of people write with em dashes, so one alone is weak evidence.
  assert.deepEqual(aiStyle("Widgets — the good kind."), { points: 1, hits: ["em dash"] });
  assert.deepEqual(aiStyle("Widgets — the good kind — the made up kind — all of them."), { points: 1, hits: ["em dash"] });
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
  // A line starting with "Thoughts?" or "Agree?" counts, even when the post doesn't end there.
  assert.deepEqual(hits("Thoughts? Let me know in the shed."), ["closing question"]);
  assert.deepEqual(hits("Widgets are great.\n  agree? Tell me below."), ["closing question"]);
  // Mid-line, only "your thoughts?" counts.
  assert.deepEqual(hits("Do you agree? Either way, widgets."), []);
});

// Made-up posts where "thoughts?" or "agree?" isn't asking the reader to react. Each one
// doesn't end with a question, so it hit only through the old "anywhere in the post" match.
for (const [name, text] of [
  ["a rhetorical question opening a line", "Second thoughts? Never. Twelve years after leaving the office job I still think opening the made-up bakery was the right call. The early mornings are rough, but the regulars make up for it."],
  ["a quoted question", 'At the planning meeting someone asked "do we all agree?" and the room went quiet. We did not, as it turned out, and the project was better for the argument that followed.'],
  ["afterthoughts?", "Any afterthoughts? Only that I should have packed a bigger umbrella for the made-up coastal walk. Photos from the day are in the comments."],
  ["disagree? mid-line", "Would anyone disagree? Probably my brother, who still insists the old shed roof was fine. It was not fine. It leaked onto the lawnmower for three winters."],
  ["disagree? starting a line", "The old shed roof was fine, according to my brother.\nDisagree? So do I. It leaked onto the lawnmower for three winters."],
]) {
  test(`closing question: not for ${name}`, () => {
    assert.deepEqual(hits(text), [], name);
  });
}

test("closing question: a quoted \"agree?\" no longer tips a post with a stock phrase over the line", () => {
  const text = 'Here\'s what surprised me at the made-up volunteers\' meeting. Someone asked "do we all agree?" and for once we actually did. The litter pick is moving to Sundays.';
  assert.deepEqual(aiStyle(text), { points: 2, hits: ["stock phrases"] });
  assert.ok(aiStyle(text).points < STYLE_MIN_POINTS);
});

// Made-up engagement bait that doesn't end with a question. These hit before the change too;
// they guard against narrowing the rule so far that it only looks at the last character.
for (const [name, text] of [
  ["Thoughts? then a call to action", "Consistency beats intensity every single time.\n\nSmall habits, repeated daily, compound into big results.\n\nThoughts? Drop them in the comments 👇"],
  ["Agree? then a repost line", "Leadership is not a title. It is a decision you make every day.\n\nAgree? Repost ♻️ to share with your network."],
  ["your thoughts? mid-line", "The best teams I have seen share one habit: they write things down. What are your thoughts? Let me know below."],
]) {
  test(`closing question: still counts ${name}`, () => {
    assert.ok(hits(text).includes("closing question"), name);
  });
}

test("numbered list: three or more lines starting with a number and . or ), worth 1", () => {
  assert.deepEqual(aiStyle("Steps:\n1. open\n2. close\n3. repeat"), { points: 1, hits: ["numbered list"] });
  assert.deepEqual(hits("Steps:\n1) open\n  2) close\n10) repeat"), ["numbered list"]);
  assert.deepEqual(hits("Steps:\n1. open\n2. close"), []); // two is not enough
  assert.deepEqual(hits("Steps:\n1.open\n2.close\n3.repeat"), []); // a space after the number is required
});

test("points add up and hits keep the signal order from STYLE_SIGNALS", () => {
  // Two em dashes here, still 1 point between them.
  assert.deepEqual(aiStyle("Widgets — **bold** — delve in.\n1. a\n2. b\n3. c"), {
    points: 3 + 1 + 2 + 1,
    hits: ["markdown", "em dash", "stock phrases", "numbered list"],
  });
});

test("STYLE_MIN_POINTS is 3: markdown alone flags, an em dash needs 2 more points to flag", () => {
  assert.equal(STYLE_MIN_POINTS, 3);
  assert.ok(aiStyle("Some **bold words**.").points >= STYLE_MIN_POINTS);
  // A common human pattern: one em dash and a question at the end. 1 + 1 = 2, not flagged.
  assert.deepEqual(aiStyle("Widgets — are they worth it?"), { points: 2, hits: ["em dash", "closing question"] });
  // With a 2-point signal, or two 1-point ones, an em dash still tips a post over.
  assert.deepEqual(aiStyle("Here's what I learned — widgets."), { points: 3, hits: ["em dash", "stock phrases"] });
  assert.deepEqual(aiStyle("Steps — in order:\n1. dig\n2. plant\n3. water\nWhich would you pick?"), {
    points: 3,
    hits: ["em dash", "closing question", "numbered list"],
  });
  assert.ok(aiStyle("Widgets — the good kind.").points < STYLE_MIN_POINTS);
  assert.ok(aiStyle("Thoughts?").points < STYLE_MIN_POINTS);
});

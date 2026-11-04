// Scores labeled posts with the style rules (style.js), like the compare page, but without a browser.
// The file uses the compare page's format: posts separated by a line with just ===,
// each starting with a line saying AI or Human. The models aren't run here.
// Usage: node scripts/score.js posts.txt
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// style.js and parse.js are plain scripts (no exports), so run them as ones and read their globals back.
for (const file of ["style.js", "parse.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), { filename: file });
}
const { parse, aiStyle, STYLE_SIGNALS, STYLE_MIN_POINTS } = vm.runInThisContext(
  "({ parse, aiStyle, STYLE_SIGNALS, STYLE_MIN_POINTS })"
);

// Parses the input and adds each post's style result, as the compare page does.
// Windows line endings become \n first, as they do in the page's textarea.
function score(input) {
  const rows = parse(input.replace(/\r\n?/g, "\n"));
  for (const row of rows) row.style = aiStyle(row.text);
  return rows;
}

// Same test as the compare page and the extension: STYLE_MIN_POINTS or more flags a post.
const isFlagged = (row) => row.style.points >= STYLE_MIN_POINTS;

// The start of a post on one line, for the list of flagged posts.
const snippet = (text) => {
  const line = text.replace(/\s+/g, " ");
  return line.length > 50 ? `${line.slice(0, 50)}…` : line;
};

// The compare page's style summary, how often each signal fired (flagged or not),
// then one line per flagged post with its number in the file and the signals it hit.
function report(rows) {
  const count = (label) => rows.filter((r) => r.label === label).length;
  const flagged = (label) => rows.filter((r) => r.label === label && isFlagged(r)).length;
  const fired = (label, name) => rows.filter((r) => r.label === label && r.style.hits.includes(name)).length;
  const table = [
    ["Signal", "Points", "AI posts", "Human posts"],
    ...STYLE_SIGNALS.map(([name, weight]) => [
      name,
      String(weight),
      `${fired("AI", name)} of ${count("AI")}`,
      `${fired("Human", name)} of ${count("Human")}`,
    ]),
  ];
  const widths = table[0].map((_, col) => Math.max(...table.map((row) => row[col].length)));
  return [
    "Style rules (the extension flags these without running a model)",
    `Catches ${flagged("AI")} of ${count("AI")} AI posts, wrongly flags ${flagged("Human")} of ${count("Human")} human posts`,
    "",
    `How often each signal fired (a post is flagged at ${STYLE_MIN_POINTS}+ points):`,
    ...table.map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd()),
    "",
    "Flagged posts:",
    ...rows.flatMap((r, i) =>
      isFlagged(r) ? [`Post ${i + 1}, ${r.label}, ${r.style.points} points: ${r.style.hits.join(", ")}. "${snippet(r.text)}"`] : []
    ),
    ...(rows.some(isFlagged) ? [] : ["none"]),
  ].join("\n");
}

module.exports = { score, report };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/score.js posts.txt");
    process.exit(1);
  }
  try {
    const rows = score(fs.readFileSync(file, "utf8"));
    if (!rows.length) throw new Error(`No posts in ${file}.`);
    console.log(report(rows));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

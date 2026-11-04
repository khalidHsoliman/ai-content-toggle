// Formatting and phrases typical of ChatGPT-style LinkedIn posts. Used by content.js and compare.js.
// Each signal adds its weight; a post with STYLE_MIN_POINTS or more counts as AI-style.
// Unicode bold and closing questions weigh little: influencers used them long before ChatGPT.
// Em dashes weigh little too: plenty of people write with them.
const STYLE_MIN_POINTS = 3;

const STYLE_SIGNALS = [
  // LinkedIn doesn't render markdown, so **bold** or ## headings mean text pasted from a chatbot.
  ["markdown", 3, (t) => /\*\*[^*\n]+\*\*|^#{1,3} /m.test(t)],
  ["Unicode bold", 1, (t) => /[\u{1D400}-\u{1D7FF}]/u.test(t)],
  // Two or more lines starting with an arrow or emoji: → ↳ ✅ 👉 📌 …
  // Plain • dots and ▪ ▫ squares (word-processor bullets) don't count, nor © ® ™:
  // Unicode lists those five as pictographic, like emoji.
  ["arrow bullets", 2, (t) => (t.match(/^\s*(?:[→↳➜►◆]|(?![©®™▪▫])\p{Extended_Pictographic})/gmu) ?? []).length >= 2],
  ["em dash", 1, (t) => /—/.test(t)],
  // Eight or more lines, nearly all of them short.
  ["short lines", 1, (t) => {
    const lines = t.split("\n").filter((line) => line.trim());
    return lines.length >= 8 && lines.filter((line) => line.length < 70).length / lines.length > 0.75;
  }],
  ["stock phrases", 2, (t) =>
    /here['’]s (?:what|the thing|how|why)|key takeaways?|the results?(?: after| were| are)?:|important note|let that sink in|game[- ]changer|in today['’]s (?:fast|digital|world)|\bdelve\b|unlock(?:ing)? (?:the|your)|navigat(?:e|ing) the|ever[- ]evolving|(?:isn['’]t|is not|wasn['’]t) just|not just .{3,40}, (?:but|it['’]s)|save this|follow .{2,40} for more|repost ♻|(?:thrilled|excited) to (?:announce|share)|tl;dr/i.test(t)],
  // Ends with an engagement question ("Which books changed your career?"), hashtags aside.
  ["closing question", 1, (t) => /\?\s*(?:#\S+\s*)*$/.test(t.trim()) || /(?:thoughts|agree)\?/i.test(t)],
  ["numbered list", 1, (t) => (t.match(/^\s*(?:\d+[.)]|[\u{1D7CE}-\u{1D7FF}][.)])\s+\S/gmu) ?? []).length >= 3],
];

// Returns the matched signal names and their total weight.
function aiStyle(text) {
  const hits = STYLE_SIGNALS.filter(([, , test]) => test(text));
  return { points: hits.reduce((sum, [, weight]) => sum + weight, 0), hits: hits.map(([name]) => name) };
}

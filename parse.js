// Reads labeled posts for the accuracy tests. Used by compare.js and scripts/score.js.
// Posts are separated by a line with just ===, and each starts with a line saying AI or Human.
function parse(input) {
  return input
    .split(/^===\s*$/m)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, i) => {
      const [first, ...rest] = block.split("\n");
      const label = first.trim().toLowerCase();
      if (label !== "ai" && label !== "human") {
        throw new Error(`Post ${i + 1} doesn't start with a line saying AI or Human.`);
      }
      return { label: label === "ai" ? "AI" : "Human", text: rest.join("\n").trim() };
    });
}

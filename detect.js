// How a post's model scores become the reply content.js gets. Kept free of chrome.* and
// Transformers.js so it can be tested with `node --test` (see test/detect.test.mjs):
// background.js loads the models and passes in the two scoring functions.

export const THRESHOLD = 0.9; // flag only when the model is quite sure; lower it to hide more

// score is the highest of the text and image scores; textScore is the text model's alone
// (null when no text was sent), for the middle band in rules.js.
// textScore(text) resolves to P(AI), or rejects when the text model fails (e.g. its download).
// imageScore(url) resolves to P(AI), to null when that image can't be fetched (dead link), or
// rejects when the image model fails (e.g. its download) or the browser is offline.
// A rejection fails the whole post: background.js replies null and content.js tries it again
// after the retry wait. A skipped image doesn't: the text and the other images decide, and a
// post left with no score at all gets score 0, like one with nothing to check.
export async function detect({ text, images }, { textScore, imageScore }) {
  const fromText = text ? await textScore(text) : null;
  const scores = fromText === null ? [] : [fromText];
  for (const url of images) {
    const fromImage = await imageScore(url);
    if (fromImage !== null) scores.push(fromImage);
  }
  const score = Math.max(0, ...scores);
  return { score, isAI: score >= THRESHOLD, textScore: fromText };
}

// Pins the behaviour of rules.js. Run with `node --test` from the repo root.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// rules.js is a plain script (no exports), so run it as one here and read its globals back.
// style.js first, as in the manifest: aiVerdict uses its STYLE_MIN_POINTS.
for (const file of ["style.js", "rules.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), { filename: file });
}
const { needsAICheck, needsAdCheck, adVerdict, retry, isPromotedLabel, isMostlyLatin, detectableText, pickMedia } =
  vm.runInThisContext("({ needsAICheck, needsAdCheck, adVerdict, retry, isPromotedLabel, isMostlyLatin, detectableText, pickMedia })");
const { aiVerdict, BAND_MIN_SCORE, BAND_MIN_POINTS, STYLE_MIN_POINTS } =
  vm.runInThisContext("({ aiVerdict, BAND_MIN_SCORE, BAND_MIN_POINTS, STYLE_MIN_POINTS })");

// A reply from background.js. Its THRESHOLD (0.9) decides isAI; these tests only see the result.
const reply = (score) => ({ score, isAI: score >= 0.9 });
const TEXT_ONLY = false;
const WITH_IMAGES = true;

test("aiVerdict: the band is a score of 0.5 or more with 2 or more style points; 3 points flag alone", () => {
  assert.equal(BAND_MIN_SCORE, 0.5);
  assert.equal(BAND_MIN_POINTS, 2);
  assert.equal(STYLE_MIN_POINTS, 3);
});

test("aiVerdict: 3+ style points flag with no model score at all, so the models are skipped", () => {
  assert.equal(aiVerdict(3, null), "style");
  assert.equal(aiVerdict(7, null), "style");
  // Style wins whatever the model says, and with or without images.
  assert.equal(aiVerdict(3, reply(0.1), WITH_IMAGES), "style");
  assert.equal(aiVerdict(3, reply(0.95), TEXT_ONLY), "style");
});

test("aiVerdict: with no model score (not sent, downloading, failed), fewer than 3 points never flag", () => {
  for (const points of [0, 1, 2]) {
    assert.equal(aiVerdict(points, null), "", `${points} points`);
    assert.equal(aiVerdict(points, null, TEXT_ONLY), "", `${points} points, text only`);
    assert.equal(aiVerdict(points, undefined, TEXT_ONLY), "", `${points} points, undefined result`);
  }
});

test("aiVerdict: at 0.9 the model flags on its own, with no style points, with or without images", () => {
  assert.equal(aiVerdict(0, reply(0.9), TEXT_ONLY), "model");
  assert.equal(aiVerdict(0, reply(0.9), WITH_IMAGES), "model");
  assert.equal(aiVerdict(2, reply(0.99), TEXT_ONLY), "model"); // the clear case, not the band
  // The 0.9 itself lives in background.js: aiVerdict trusts isAI, whatever the score.
  assert.equal(aiVerdict(0, { score: 0.5, isAI: true }, TEXT_ONLY), "model");
  assert.equal(aiVerdict(0, { score: 0.95, isAI: false }, TEXT_ONLY), "");
});

test("aiVerdict: just under 0.9, 2 style points flag through the band and 1 doesn't", () => {
  assert.equal(aiVerdict(2, reply(0.89), TEXT_ONLY), "band");
  assert.equal(aiVerdict(1, reply(0.89), TEXT_ONLY), "");
  assert.equal(aiVerdict(0, reply(0.89), TEXT_ONLY), "");
});

test("aiVerdict: the band starts at exactly 0.5", () => {
  assert.equal(aiVerdict(2, reply(0.5), TEXT_ONLY), "band");
  assert.equal(aiVerdict(2, reply(0.49), TEXT_ONLY), "");
  assert.equal(aiVerdict(2, reply(0.4999), TEXT_ONLY), "");
  assert.equal(aiVerdict(1, reply(0.5), TEXT_ONLY), "");
});

test("aiVerdict: no band for posts sent with images, whose score may be an image's", () => {
  assert.equal(aiVerdict(2, reply(0.7), WITH_IMAGES), "");
  assert.equal(aiVerdict(2, reply(0.5), WITH_IMAGES), "");
  assert.equal(aiVerdict(2, reply(0.89), WITH_IMAGES), "");
});

test("aiVerdict: low scores and no style points don't flag", () => {
  assert.equal(aiVerdict(0, reply(0), TEXT_ONLY), "");
  assert.equal(aiVerdict(2, reply(0.1), TEXT_ONLY), "");
  assert.equal(aiVerdict(1, reply(0.7), TEXT_ONLY), "");
});

test("needsAICheck: a post without data-ai is due for a check, even while the models wait", () => {
  // The style check doesn't need the models, so new posts are never held back.
  assert.equal(needsAICheck({}, true), true);
  assert.equal(needsAICheck({}, false), true);
});

test("needsAICheck: a post already decided is not checked again", () => {
  for (const canRetry of [true, false]) {
    assert.equal(needsAICheck({ ai: "yes" }, canRetry), false);
    assert.equal(needsAICheck({ ai: "no" }, canRetry), false);
  }
});

test("needsAICheck: a failed check is tried again, once the models may be retried", () => {
  assert.equal(needsAICheck({ ai: "error" }, true), true);
  assert.equal(needsAICheck({ ai: "error" }, false), false);
});

test("needsAICheck: a check still in flight is not started twice", () => {
  // A post only stays "checking" for good when the extension was reloaded, and then this
  // script is dead anyway: the tab needs a refresh, which starts over with a clean DOM.
  assert.equal(needsAICheck({ ai: "checking" }, true), false);
});

test("needsAICheck: a hidden ad is not sent to AI detection", () => {
  assert.equal(needsAICheck({ ad: "yes" }, true, true), false);
  assert.equal(needsAICheck({ ad: "yes", ai: "error" }, true, true), false);
  // With the ads switch off the ad is visible, so it's checked like any other post.
  assert.equal(needsAICheck({ ad: "yes" }, true, false), true);
  // An ordinary post is checked whatever the ads switch says.
  assert.equal(needsAICheck({ ad: "no" }, true, true), true);
});

test("retry: nothing waits until a check fails", () => {
  retry.reset();
  assert.equal(retry.ready(0), true);
  assert.equal(retry.ready(1e12), true);
});

test("retry: after a failure the models wait 10 s, doubling per failed round, up to 10 min", () => {
  retry.reset();
  retry.failed(1000);
  assert.equal(retry.ready(10_999), false);
  assert.equal(retry.ready(11_000), true);
  // A check that was already in flight fails too: same round, so the wait isn't doubled.
  retry.failed(1500);
  assert.equal(retry.failures, 1);
  assert.equal(retry.at, 11_500);
  // The next rounds fail: 20 s, then 40 s, ...
  retry.failed(11_500);
  assert.equal(retry.at, 31_500);
  retry.failed(31_500);
  assert.equal(retry.at, 71_500);
  // ... 80 s, 160 s, 320 s, then never more than 10 minutes, however long it keeps failing.
  for (let i = 0; i < 3; i++) retry.failed(retry.at);
  assert.equal(retry.at, 71_500 + 80_000 + 160_000 + 320_000);
  retry.failed(retry.at);
  assert.equal(retry.at, 631_500 + 600_000); // 640 s would be past the cap
  for (let i = 0; i < 5000; i++) retry.failed(retry.at); // 2 ** 5000 is Infinity; the cap holds
  const last = retry.at;
  retry.failed(last);
  assert.equal(retry.at, last + 600_000);
});

test("retry: a successful check, or a flipped switch, ends the wait and forgets the failures", () => {
  retry.reset();
  retry.failed(0);
  retry.failed(10_000);
  assert.equal(retry.ready(10_001), false);
  retry.reset();
  assert.equal(retry.ready(10_001), true);
  retry.failed(10_001); // the next failure starts over at 10 s, not 40 s
  assert.equal(retry.at, 20_001);
});

test("needsAdCheck: a post is walked until it has a verdict, then never again", () => {
  assert.equal(needsAdCheck({}), true);
  assert.equal(needsAdCheck({ ad: "yes" }), false);
  assert.equal(needsAdCheck({ ad: "no" }), false);
});

test("adVerdict: an ordinary post gets \"no\", so it's walked once, not every second", () => {
  assert.equal(adVerdict(false, true), "no");
  assert.equal(needsAdCheck({ ad: adVerdict(false, true) }), false);
});

test("adVerdict: a post with the Promoted label is an ad", () => {
  assert.equal(adVerdict(true, true), "yes");
});

test("adVerdict: a post with no content yet gets no verdict, so it's walked again", () => {
  assert.equal(adVerdict(false, false), undefined);
  assert.equal(needsAdCheck({ ad: adVerdict(false, false) }), true);
});

test("isPromotedLabel: matches the English label, alone or with a sponsor", () => {
  assert.equal(isPromotedLabel("Promoted"), true);
  assert.equal(isPromotedLabel("Promoted by Example Widgets Ltd"), true);
  assert.equal(isPromotedLabel("  Promoted\n"), true); // surrounding whitespace is ignored
});

test("isPromotedLabel: rejects anything that isn't exactly the label", () => {
  assert.equal(isPromotedLabel(""), false);
  assert.equal(isPromotedLabel("promoted"), false); // case-sensitive
  assert.equal(isPromotedLabel("Promoted by"), false); // sponsor name required after "by"
  assert.equal(isPromotedLabel("Promoted post"), false);
  assert.equal(isPromotedLabel("I got promoted today!"), false);
  assert.equal(isPromotedLabel("Sponsorisé"), false); // other languages aren't matched
});

test("isMostlyLatin: English text passes, other scripts don't", () => {
  assert.equal(isMostlyLatin("Plain made-up sentence about widgets and gadgets."), true);
  assert.equal(isMostlyLatin("Αυτό είναι ένα φτιαχτό παράδειγμα κειμένου."), false);
  assert.equal(isMostlyLatin("هذا نص مثال مختلق لأغراض الاختبار فقط."), false);
});

test("isMostlyLatin: needs more than 60% Latin letters; non-letters don't count", () => {
  // 7 Latin letters out of 10 letters: 70% > 60%
  assert.equal(isMostlyLatin("abcdefg αβγ"), true);
  // 6 Latin letters out of 10 letters: exactly 60%, which is not enough
  assert.equal(isMostlyLatin("abcdef αβγδ"), false);
  // Accented Latin letters count as letters but not as Latin
  assert.equal(isMostlyLatin("ééééé ab"), false);
  // Digits, punctuation and emoji aren't letters, so they don't dilute the ratio
  assert.equal(isMostlyLatin("ab 12345 !!! 🎉🎉🎉"), true);
  // No letters at all: 0 > 0 is false
  assert.equal(isMostlyLatin(""), false);
  assert.equal(isMostlyLatin("12345 🎉"), false);
});

test("detectableText: keeps English text of 200+ characters", () => {
  const long = "made up words ".repeat(20).trim(); // 279 characters
  assert.equal(detectableText(long), long);
  const exact = "x".repeat(200);
  assert.equal(detectableText(exact), exact);
});

test("detectableText: drops short or non-English text", () => {
  assert.equal(detectableText("x".repeat(199)), "");
  assert.equal(detectableText(""), "");
  assert.equal(detectableText("α".repeat(250)), "");
});

test("pickMedia: keeps LinkedIn post images and video covers, in order", () => {
  const urls = [
    "https://media.licdn.com/dms/image/v2/abc/feedshare-shrink_800/0/1?e=1&v=beta&t=x",
    "https://media.licdn.com/dms/image/v2/def/videocover-low/0/1?e=1&v=beta&t=y",
  ];
  assert.deepEqual(pickMedia(urls), urls);
});

test("pickMedia: drops avatars, company logos and anything outside /dms/image/", () => {
  const kept = "https://media.licdn.com/dms/image/v2/abc/feedshare-shrink_800/0/1";
  assert.deepEqual(
    pickMedia([
      "https://media.licdn.com/dms/image/v2/abc/profile-displayphoto-shrink_100_100/0/1",
      "https://media.licdn.com/dms/image/v2/abc/company-logo_100_100/0/1",
      "https://static.licdn.com/aero-v1/sc/h/some-icon.svg",
      "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      "",
      kept,
    ]),
    [kept]
  );
});

test("pickMedia: sends at most 3 urls, the first ones after filtering", () => {
  const url = (n) => `https://media.licdn.com/dms/image/v2/id${n}/feedshare-shrink_800/0/1`;
  const logo = "https://media.licdn.com/dms/image/v2/abc/company-logo_100_100/0/1";
  assert.deepEqual(pickMedia([logo, url(1), url(2), url(3), url(4), url(5)]), [url(1), url(2), url(3)]);
  assert.deepEqual(pickMedia([]), []);
});

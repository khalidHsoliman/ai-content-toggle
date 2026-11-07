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
const { countPosts } = vm.runInThisContext("({ countPosts })");

// Replies from background.js, built the way detect() (detect.js) builds them. Its THRESHOLD (0.9) decides
// isAI from score, the highest of the text and image scores; textScore is the text model's alone.
const verdictOf = (score, textScore) => ({ score, isAI: score >= 0.9, textScore });
const reply = (text) => verdictOf(text, text); // a post sent without images
const withImage = (text, image) => verdictOf(Math.max(text, image), text);
const imageOnly = (image) => verdictOf(image, null); // no text was sent

test("aiVerdict: the band is a text score of 0.5 or more with 2 or more style points; 3 points flag alone", () => {
  assert.equal(BAND_MIN_SCORE, 0.5);
  assert.equal(BAND_MIN_POINTS, 2);
  assert.equal(STYLE_MIN_POINTS, 3);
});

test("aiVerdict: 3+ style points flag with no model score at all, so the models are skipped", () => {
  assert.equal(aiVerdict(3, null), "style");
  assert.equal(aiVerdict(7, null), "style");
  // Style wins whatever the model says, and with or without images.
  assert.equal(aiVerdict(3, withImage(0.1, 0.1)), "style");
  assert.equal(aiVerdict(3, reply(0.95)), "style");
});

test("aiVerdict: with no model score (not sent, downloading, failed), fewer than 3 points never flag", () => {
  for (const points of [0, 1, 2]) {
    assert.equal(aiVerdict(points, null), "", `${points} points`);
    assert.equal(aiVerdict(points, undefined), "", `${points} points, undefined result`);
  }
});

test("aiVerdict: at 0.9 the model flags on its own, with no style points, with or without images", () => {
  assert.equal(aiVerdict(0, reply(0.9)), "model");
  assert.equal(aiVerdict(0, withImage(0.1, 0.9)), "model"); // an image score this high still flags alone
  assert.equal(aiVerdict(0, imageOnly(0.95)), "model");
  assert.equal(aiVerdict(2, reply(0.99)), "model"); // the clear case, not the band
  // The 0.9 itself lives in detect.js: aiVerdict trusts isAI, whatever the score.
  assert.equal(aiVerdict(0, { score: 0.5, isAI: true, textScore: 0.5 }), "model");
  assert.equal(aiVerdict(0, { score: 0.95, isAI: false, textScore: 0.95 }), "");
});

test("aiVerdict: just under 0.9, 2 style points flag through the band and 1 doesn't", () => {
  assert.equal(aiVerdict(2, reply(0.89)), "band");
  assert.equal(aiVerdict(1, reply(0.89)), "");
  assert.equal(aiVerdict(0, reply(0.89)), "");
});

test("aiVerdict: the band starts at a text score of exactly 0.5", () => {
  assert.equal(aiVerdict(2, reply(0.5)), "band");
  assert.equal(aiVerdict(2, reply(0.49)), "");
  assert.equal(aiVerdict(2, reply(0.4999)), "");
  assert.equal(aiVerdict(1, reply(0.5)), "");
});

test("aiVerdict: an image score alone never triggers the band", () => {
  // The highest score is the image's and sits in the band, but the text score is below 0.5.
  assert.equal(aiVerdict(2, withImage(0.3, 0.7)), "");
  assert.equal(aiVerdict(2, withImage(0.49, 0.89)), "");
  assert.equal(aiVerdict(2, withImage(0, 0.5)), "");
  // No text score at all (no text was sent): no band, whatever the image scored.
  assert.equal(aiVerdict(2, imageOnly(0.7)), "");
  assert.equal(aiVerdict(2, { score: 0.7, isAI: false }), ""); // a reply without textScore
});

test("aiVerdict: a text score in the band flags with 2 style points, with or without images", () => {
  assert.equal(aiVerdict(2, reply(0.7)), "band");
  assert.equal(aiVerdict(2, withImage(0.7, 0.1)), "band"); // the image scored lower
  assert.equal(aiVerdict(2, withImage(0.6, 0.8)), "band"); // the image scored higher, still under 0.9
  assert.equal(aiVerdict(2, withImage(0.5, 0.2)), "band");
  assert.equal(aiVerdict(1, withImage(0.7, 0.8)), ""); // still needs 2 style points
});

test("aiVerdict: low scores and no style points don't flag", () => {
  assert.equal(aiVerdict(0, reply(0)), "");
  assert.equal(aiVerdict(2, reply(0.1)), "");
  assert.equal(aiVerdict(1, reply(0.7)), "");
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

// Posts' datasets as content.js leaves them (data-ai-style is dataset.aiStyle, and so on).
const unchecked = {};
const human = { ai: "no", aiScore: "0.12", aiPercent: "12" };
const byModel = { ai: "yes", aiScore: "0.95", aiPercent: "95" };
const byStyle = { ai: "yes", aiStyle: "markdown, em dash" }; // flagged before the models ran: no score
const byBand = { ai: "yes", aiScore: "0.70", aiPercent: "70", aiBand: "em dash, closing question" };
const checking = { ai: "checking" };
const failed = { ai: "error" };
const opened = (d) => ({ ...d, revealed: "yes" });
const ad = (d = {}) => ({ ...d, ad: "yes" });
const zero = { posts: 0, checked: 0, checking: 0, failed: 0, model: 0, style: 0, band: 0, revealed: 0, ads: 0 };
const counts = (more) => ({ ...zero, ...more });

test("countPosts: a page with no posts counts nothing", () => {
  assert.deepEqual(countPosts([]), zero);
});

test("countPosts: posts not checked yet only count as posts", () => {
  // No data-ai yet (not scrolled near, or Hide AI posts is off), and an ordinary post the ad check passed.
  assert.deepEqual(countPosts([unchecked, { ad: "no" }]), counts({ posts: 2 }));
});

test("countPosts: a post the check let through counts as checked, not hidden", () => {
  assert.deepEqual(countPosts([human]), counts({ posts: 1, checked: 1 }));
  // Style too short for a verdict and no text or images to send: data-ai "no" without a score.
  assert.deepEqual(countPosts([{ ai: "no" }]), counts({ posts: 1, checked: 1 }));
});

test("countPosts: a flagged post counts as checked and under the model, style or band", () => {
  assert.deepEqual(countPosts([byModel]), counts({ posts: 1, checked: 1, model: 1 }));
  assert.deepEqual(countPosts([byStyle]), counts({ posts: 1, checked: 1, style: 1 }));
  assert.deepEqual(countPosts([byBand]), counts({ posts: 1, checked: 1, band: 1 }));
});

test("countPosts: style comes before band, as in aiVerdict, if a post ever had both", () => {
  assert.deepEqual(countPosts([{ ...byBand, aiStyle: "markdown" }]), counts({ posts: 1, checked: 1, style: 1 }));
});

test("countPosts: a post still being checked counts as checking, not checked or failed", () => {
  assert.deepEqual(countPosts([checking, checking]), counts({ posts: 2, checking: 2 }));
});

test("countPosts: a failed check counts as failed, not checked", () => {
  assert.deepEqual(countPosts([failed]), counts({ posts: 1, failed: 1 }));
});

test("countPosts: a revealed post keeps its reason and counts as revealed too", () => {
  assert.deepEqual(
    countPosts([opened(byModel), opened(byStyle), opened(byBand), byModel]),
    counts({ posts: 4, checked: 4, model: 2, style: 1, band: 1, revealed: 3 })
  );
});

test("countPosts: data-revealed on a post that isn't flagged counts for nothing", () => {
  // content.js only reveals flagged posts; anything else is ignored rather than miscounted.
  assert.deepEqual(countPosts([opened(human), opened(failed)]), counts({ posts: 2, checked: 1, failed: 1 }));
});

test("countPosts: an ad no check reached counts as an ad only", () => {
  assert.deepEqual(countPosts([ad()]), counts({ posts: 1, ads: 1 }));
});

test("countPosts: an ad that was checked counts as checked and as an ad, never under an AI reason", () => {
  // Checked before Hide ads was on, or before LinkedIn filled in its Promoted label.
  assert.deepEqual(countPosts([ad(human)]), counts({ posts: 1, checked: 1, ads: 1 }));
  assert.deepEqual(
    countPosts([ad(byModel), ad(byStyle), ad(byBand), ad(opened(byModel))]),
    counts({ posts: 4, checked: 4, ads: 4 })
  );
});

test("countPosts: an ad still being checked, or whose check failed, counts in both", () => {
  assert.deepEqual(countPosts([ad(checking), ad(failed)]), counts({ posts: 2, checking: 1, failed: 1, ads: 2 }));
});

test("countPosts: data-ad \"no\" is an ordinary post, hidden by its AI reason", () => {
  assert.deepEqual(countPosts([{ ...byBand, ad: "no" }]), counts({ posts: 1, checked: 1, band: 1 }));
});

test("countPosts: a whole page, and the datasets are left as they were", () => {
  const page = [unchecked, human, human, byModel, opened(byStyle), byBand, checking, failed, ad(), ad(human), { ad: "no" }];
  const before = JSON.stringify(page);
  assert.deepEqual(
    countPosts(page),
    counts({ posts: 11, checked: 6, checking: 1, failed: 1, model: 1, style: 1, band: 1, revealed: 1, ads: 2 })
  );
  assert.equal(JSON.stringify(page), before);
});

test("countPosts: takes any iterable, like the datasets mapped from querySelectorAll", () => {
  function* datasets() {
    yield byModel;
    yield ad();
  }
  assert.deepEqual(countPosts(datasets()), counts({ posts: 2, checked: 1, model: 1, ads: 1 }));
});

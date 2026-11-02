// Pins the behaviour of rules.js. Run with `node --test` from the repo root.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// rules.js is a plain script (no exports), so run it as one here and read its globals back.
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "rules.js"), "utf8"), { filename: "rules.js" });
const { needsAICheck, needsAdCheck, adVerdict, retry, isPromotedLabel, isMostlyLatin, detectableText, pickMedia } =
  vm.runInThisContext("({ needsAICheck, needsAdCheck, adVerdict, retry, isPromotedLabel, isMostlyLatin, detectableText, pickMedia })");

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

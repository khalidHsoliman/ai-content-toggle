// The decisions content.js makes about a post, kept free of DOM access so they can be
// tested with `node --test` (see test/). Loaded after style.js and before content.js.

const PROMOTED = /^Promoted( by .+)?$/; // LinkedIn's English label on ad posts

const MIN_TEXT_LENGTH = 200; // text detectors are unreliable on short posts
const MAX_IMAGES = 3;

// The middle band: a text model score from BAND_MIN_SCORE up to the model's own threshold
// (THRESHOLD in detect.js, which owns it) flags a post with BAND_MIN_POINTS style points.
const BAND_MIN_SCORE = 0.5;
const BAND_MIN_POINTS = 2;

const RETRY_DELAY = 10_000; // after a failed check, wait this long before sending more posts...
const MAX_RETRY_DELAY = 10 * 60_000; // ...doubling while checks keep failing, up to this

// Whether scan() should (re)check a post, given its data-* attributes. A post whose check
// failed (model download, service worker) is tried again once the models may be retried;
// one still being checked is not. Nor is a post hidden as an ad: the models would work for nothing.
function needsAICheck(dataset, canRetry, adsHidden) {
  if (adsHidden && dataset.ad === "yes") return false;
  return !dataset.ai || (dataset.ai === "error" && canRetry);
}

// Why a post counts as AI, or "" when it doesn't:
//   "style": STYLE_MIN_POINTS (style.js) or more style points, so the models aren't needed
//   "model": the model is sure on its own (isAI, decided by THRESHOLD in detect.js)
//   "band":  a middling score plus some style points (see BAND_MIN_SCORE above)
// result is the model's reply, { score, isAI, textScore }, or null when there is none yet
// (not sent, still downloading, failed): then style points alone decide, as they always have.
// score is the highest of the text and image scores, so the band uses textScore, the text
// model's alone: an image score never triggers it. No text score (null), no band.
function aiVerdict(points, result) {
  if (points >= STYLE_MIN_POINTS) return "style";
  if (!result) return "";
  if (result.isAI) return "model";
  if (result.textScore != null && points >= BAND_MIN_POINTS && result.textScore >= BAND_MIN_SCORE) return "band";
  return "";
}

// The wait after a failed check, so the models aren't retried every second while they're
// down. Only sending to the models waits; the style check (style.js) never does.
const retry = {
  failures: 0,
  at: 0, // Date.now() before which nothing is sent to the models
  ready(now) {
    return now >= this.at;
  },
  failed(now) {
    if (this.ready(now)) this.failures++; // checks already in flight count as one failure
    this.at = now + Math.min(RETRY_DELAY * 2 ** (this.failures - 1), MAX_RETRY_DELAY);
  },
  reset() {
    this.failures = this.at = 0; // after a successful check, or when the user flips a switch
  },
};

function needsAdCheck(dataset) {
  return !dataset.ad;
}

// data-ad after looking for the Promoted label: "yes", or "no" so the post isn't walked again.
// A post with no content yet gets neither, since LinkedIn fills some posts in later.
function adVerdict(promoted, rendered) {
  return promoted ? "yes" : rendered ? "no" : undefined;
}

// Whether an element's text is LinkedIn's "Promoted" label.
function isPromotedLabel(text) {
  return PROMOTED.test(text.trim());
}

// The text model only knows English, so skip posts written mostly in other scripts.
function isMostlyLatin(text) {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  return latin > 0.6 * letters;
}

// The post text to send to the text model, or "" when it's too short or not English.
function detectableText(text) {
  return text.length >= MIN_TEXT_LENGTH && isMostlyLatin(text) ? text : "";
}

// Post images and video cover frames, without avatars and logos.
function pickMedia(urls) {
  return urls
    .filter((url) => url.includes("/dms/image/") && !/profile-displayphoto|company-logo/.test(url))
    .slice(0, MAX_IMAGES);
}

// The decisions content.js makes about a post, kept free of DOM access so they can be
// tested with `node --test` (see test/). Loaded before content.js, like style.js.

const PROMOTED = /^Promoted( by .+)?$/; // LinkedIn's English label on ad posts

const MIN_TEXT_LENGTH = 200; // text detectors are unreliable on short posts
const MAX_IMAGES = 3;

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

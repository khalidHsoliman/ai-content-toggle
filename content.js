// LinkedIn changes its markup often. If posts stop getting checked, right-click a
// post, choose Inspect, and update these selectors. Each one lists the current
// layout first, then the older layout that some accounts may still have.
const POST =
  '[role="listitem"][componentkey^="update-card"], [data-urn*="urn:li:activity"], [data-id*="urn:li:activity"]';
const POST_TEXT =
  '[data-testid="expandable-text-box"], .update-components-text, .feed-shared-inline-show-more-text';
const COMMENT = '[componentkey*="urn:li:comment"]'; // comments use the same text box; skip them

const MIN_TEXT_LENGTH = 200; // text detectors are unreliable on short posts
const MAX_IMAGES = 3;

let enabled = false;

// Check each post once, when it scrolls near the screen (so its images have loaded).
const io = new IntersectionObserver(
  (entries) => {
    for (const { isIntersecting, target } of entries) {
      if (enabled && isIntersecting) {
        io.unobserve(target);
        check(target);
      }
    }
  },
  { rootMargin: "300px" }
);

function scan() {
  // observe() ignores posts it's already watching, so repeating this is safe.
  document.querySelectorAll(POST).forEach((post) => {
    if (!post.dataset.ai) io.observe(post);
  });
}

// The text model only knows English, so skip posts written mostly in other scripts.
function isMostlyLatin(text) {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  return latin > 0.6 * letters;
}

// Post images and video cover frames, without avatars and logos.
function mediaUrls(post) {
  const images = [...post.querySelectorAll("img")].map((img) => img.src);
  const posters = [...post.querySelectorAll("video[poster]")].map((v) => v.poster);
  return [...images, ...posters]
    .filter((url) => url.includes("/dms/image/") && !/profile-displayphoto|company-logo/.test(url))
    .slice(0, MAX_IMAGES);
}

async function check(post) {
  post.dataset.ai = "checking";
  const textBox = [...post.querySelectorAll(POST_TEXT)].find((el) => !el.closest(COMMENT));
  const rawText = textBox?.innerText.trim() ?? "";
  const text = rawText.length >= MIN_TEXT_LENGTH && isMostlyLatin(rawText) ? rawText : "";
  const images = mediaUrls(post);
  if (!text && images.length === 0) {
    post.dataset.ai = "no";
    return;
  }
  try {
    const result = await chrome.runtime.sendMessage({ type: "detect", text, images });
    if (!result) throw new Error("detection failed");
    post.dataset.ai = result.isAI ? "yes" : "no";
    post.dataset.aiScore = result.score.toFixed(2); // visible in DevTools when tuning
  } catch (err) {
    if (!chrome.runtime?.id) return; // extension was reloaded or updated; this tab needs a refresh
    console.warn("AI Content Toggle:", err);
    post.dataset.ai = "error";
  }
}

function apply(on) {
  enabled = !!on;
  document.documentElement.classList.toggle("hide-ai", enabled);
  if (enabled) {
    io.disconnect(); // re-observe so posts already on screen get checked now
    scan();
  }
}

chrome.storage.local.get("hideAI").then(({ hideAI }) => apply(hideAI));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.hideAI) apply(changes.hideAI.newValue);
});
// LinkedIn adds posts as you scroll. After the extension is reloaded or updated, this old
// copy of the script can't reach it anymore, so it stops quietly until the tab is refreshed.
const timer = setInterval(() => {
  if (!chrome.runtime?.id) return clearInterval(timer);
  if (enabled) scan();
}, 1000);

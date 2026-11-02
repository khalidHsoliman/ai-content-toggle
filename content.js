// LinkedIn changes its markup often. If posts stop getting checked, right-click a
// post, choose Inspect, and update these selectors. Each one lists the current
// layout first, then the older layout that some accounts may still have.
const POST =
  '[role="listitem"][componentkey^="update-card"], [data-urn*="urn:li:activity"], [data-id*="urn:li:activity"]';
const POST_TEXT =
  '[data-testid="expandable-text-box"], .update-components-text, .feed-shared-inline-show-more-text';
const COMMENT = '[componentkey*="urn:li:comment"]'; // comments use the same text box; skip them
// The rules for what to check and what to send (Promoted label, text, media) are in rules.js.

let hideAI = false;
let hideAds = false;

// Check each post once, when it scrolls near the screen (so its images have loaded).
const io = new IntersectionObserver(
  (entries) => {
    for (const { isIntersecting, target } of entries) {
      if (hideAI && isIntersecting) {
        io.unobserve(target);
        check(target);
      }
    }
  },
  { rootMargin: "300px" }
);

function scan() {
  document.querySelectorAll(POST).forEach((post) => {
    // observe() ignores posts it's already watching, so repeating this is safe.
    if (hideAI && !post.dataset.ai) io.observe(post);
    if (hideAds && !post.dataset.ad && isPromoted(post)) post.dataset.ad = "yes";
  });
}

// A "Promoted" label anywhere in the post except its own text.
function isPromoted(post) {
  return [...post.querySelectorAll("*")].some(
    (el) => !el.children.length && isPromotedLabel(el.textContent) && !el.closest(POST_TEXT)
  );
}

// Every image and video cover frame in the post; pickMedia() (rules.js) keeps the post media.
function mediaUrls(post) {
  const images = [...post.querySelectorAll("img")].map((img) => img.src);
  const posters = [...post.querySelectorAll("video[poster]")].map((v) => v.poster);
  return pickMedia([...images, ...posters]);
}

async function check(post) {
  post.dataset.ai = "checking";
  const textBox = [...post.querySelectorAll(POST_TEXT)].find((el) => !el.closest(COMMENT));
  const rawText = textBox?.innerText.trim() ?? "";
  const text = detectableText(rawText);
  // ChatGPT-style formatting (see style.js) flags a post without running the models.
  const style = text ? aiStyle(rawText) : null;
  if (style?.points >= STYLE_MIN_POINTS) {
    post.dataset.aiStyle = style.hits.join(", "); // shown on the collapsed bar
    post.dataset.ai = "yes";
    return;
  }
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
    post.dataset.aiPercent = Math.round(result.score * 100); // shown on the collapsed bar
  } catch (err) {
    if (!chrome.runtime?.id) return; // extension was reloaded or updated; this tab needs a refresh
    console.warn("AI Content Toggle:", err);
    post.dataset.ai = "error";
  }
}

// The popup's two switches are stored as hideAI and hideAds.
function apply(settings) {
  hideAI = !!settings.hideAI;
  hideAds = !!settings.hideAds;
  document.documentElement.classList.toggle("hide-ai", hideAI);
  document.documentElement.classList.toggle("hide-ads", hideAds);
  io.disconnect(); // re-observe so posts already on screen get checked now
  scan();
}

// A flagged post collapses into a one-line bar (see styles.css); clicking the bar shows it.
document.addEventListener(
  "click",
  (event) => {
    const post = event.target;
    if (hideAI && post.matches?.('[data-ai="yes"]:not([data-revealed])')) {
      event.preventDefault();
      event.stopPropagation(); // don't let LinkedIn treat it as a click on the post
      post.dataset.revealed = "yes";
    }
  },
  true
);

const loadSettings = () => chrome.storage.local.get(["hideAI", "hideAds"]).then(apply);
loadSettings();
chrome.storage.onChanged.addListener(loadSettings);
// LinkedIn adds posts as you scroll. After the extension is reloaded or updated, this old
// copy of the script can't reach it anymore, so it stops quietly until the tab is refreshed.
const timer = setInterval(() => {
  if (!chrome.runtime?.id) return clearInterval(timer);
  if (hideAI || hideAds) scan();
}, 1000);

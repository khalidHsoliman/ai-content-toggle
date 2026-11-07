// LinkedIn changes its markup often. If posts stop getting checked, right-click a
// post, choose Inspect, and update these selectors. Each one lists the current
// layout first, then the older layout that some accounts may still have.
const POST =
  '[role="listitem"][componentkey^="update-card"], [data-urn*="urn:li:activity"], [data-id*="urn:li:activity"]';
const POST_TEXT =
  '[data-testid="expandable-text-box"], .update-components-text, .feed-shared-inline-show-more-text';
const COMMENT = '[componentkey*="urn:li:comment"]'; // comments use the same text box; skip them
// The rules for what to check and what to send (Promoted label, text, media) are in rules.js.
// Each post is checked on its own content: a reshare in the old layout has the reshared post
// inside it as a post of its own, so the outer post skips whatever is inside that one
// (el.closest(POST) isn't the outer post), and the inner post is checked, counted and hidden by itself.

let hideAI = false;
let hideAds = false;
// The popup's Show all button: this tab's flagged posts are shown, and new ones come in shown.
// Not saved, and only for the page it was turned on for: refreshing the tab or moving to another
// LinkedIn page (which LinkedIn does without reloading, see the timer below) collapses them again.
let showAll = false;

// Check each post once, when it scrolls near the screen (so its images have loaded).
const io = new IntersectionObserver(
  (entries) => {
    for (const { isIntersecting, target } of entries) {
      if (hideAI && isIntersecting) {
        io.unobserve(target);
        // The post may have filled in since scan() looked: settle whether it's an ad before
        // sending it to the models (check() handles the wait after failures).
        if (hideAds && needsAdCheck(target.dataset)) checkAd(target);
        if (needsAICheck(target.dataset, true, hideAds)) check(target);
      }
    }
  },
  { rootMargin: "300px" }
);

function scan() {
  document.querySelectorAll(POST).forEach((post) => {
    if (hideAds && needsAdCheck(post.dataset)) checkAd(post);
    // After the ad check, so a hidden ad isn't observed at all.
    // observe() ignores posts it's already watching, so repeating this is safe.
    if (hideAI && needsAICheck(post.dataset, retry.ready(Date.now()), hideAds)) io.observe(post);
  });
}

// Records whether a post is an ad, once it has content to look at (see adVerdict in rules.js).
function checkAd(post) {
  const ad = adVerdict(isPromoted(post), post.textContent.trim() !== "");
  if (ad) post.dataset.ad = ad;
}

// A "Promoted" label anywhere in the post except its own text (or a post inside it).
function isPromoted(post) {
  return [...post.querySelectorAll("*")].some(
    (el) => !el.children.length && isPromotedLabel(el.textContent) && !el.closest(POST_TEXT) && el.closest(POST) === post
  );
}

// Every image and video cover frame in the post (not a post inside it); pickMedia() (rules.js) keeps the post media.
function mediaUrls(post) {
  const own = (el) => el.closest(POST) === post;
  const images = [...post.querySelectorAll("img")].filter(own).map((img) => img.src);
  const posters = [...post.querySelectorAll("video[poster]")].filter(own).map((v) => v.poster);
  return pickMedia([...images, ...posters]);
}

async function check(post) {
  post.dataset.ai = "checking";
  const textBox = [...post.querySelectorAll(POST_TEXT)].find((el) => !el.closest(COMMENT) && el.closest(POST) === post);
  const rawText = textBox?.innerText.trim() ?? "";
  const text = detectableText(rawText);
  // ChatGPT-style formatting (see style.js) flags a post without running the models:
  // with no model result yet, aiVerdict (rules.js) goes by style points alone.
  const style = text ? aiStyle(rawText) : null;
  const points = style?.points ?? 0;
  if (aiVerdict(points, null)) {
    post.dataset.aiStyle = style.hits.join(", "); // shown on the collapsed bar
    if (showAll) post.dataset.revealed = "yes"; // before data-ai, so it never flashes collapsed
    post.dataset.ai = "yes";
    return;
  }
  const images = mediaUrls(post);
  if (!text && images.length === 0) {
    post.dataset.ai = "no";
    return;
  }
  if (!retry.ready(Date.now())) {
    post.dataset.ai = "error"; // the models failed recently; this post is tried after the wait
    return;
  }
  try {
    const result = await chrome.runtime.sendMessage({ type: "detect", text, images });
    if (!result) throw new Error("detection failed");
    retry.reset();
    // The model's own verdict, or the middle band: a middling text score plus some style points.
    const verdict = aiVerdict(points, result);
    if (verdict && showAll) post.dataset.revealed = "yes";
    post.dataset.ai = verdict ? "yes" : "no";
    post.dataset.aiScore = result.score.toFixed(2); // visible in DevTools when tuning
    post.dataset.aiPercent = Math.round(result.score * 100); // shown on the collapsed bar
    if (verdict === "band") post.dataset.aiBand = style.hits.join(", "); // shown next to the percent
  } catch (err) {
    if (!chrome.runtime?.id) return; // extension was reloaded or updated; this tab needs a refresh
    console.warn("AI Content Toggle:", err);
    post.dataset.ai = "error";
    retry.failed(Date.now());
  }
}

// The popup's two switches are stored as hideAI and hideAds.
function apply(settings) {
  hideAI = !!settings.hideAI;
  hideAds = !!settings.hideAds;
  document.documentElement.classList.toggle("hide-ai", hideAI);
  document.documentElement.classList.toggle("hide-ads", hideAds);
  retry.reset(); // flipping a switch retries the models right away
  io.disconnect(); // re-observe so posts already on screen get checked now
  scan();
}

// A flagged post collapses into a one-line bar (see styles.css); clicking the bar shows it, and
// a thin bar on top of the open post collapses it again. Both bars are the post's ::before, so a
// click on them targets the post itself. A click inside the post (a link, like, comment) reaches
// this listener too, but its target is what's in the post, so it's left alone for LinkedIn.
// styles.css keeps the open post's own padding from taking clicks, leaving just the bar.
document.addEventListener(
  "click",
  (event) => {
    const post = event.target;
    if (hideAI && post.matches?.('[data-ai="yes"]')) {
      event.preventDefault();
      event.stopPropagation(); // don't let LinkedIn treat it as a click on the post
      if (post.dataset.revealed) delete post.dataset.revealed;
      else post.dataset.revealed = "yes";
    }
  },
  true
);

// Shows every flagged post on this tab, or collapses them all again (ones opened by a click too).
// Ads stay hidden either way: styles.css hides them whole, whatever data-revealed says.
function setShowAll(on) {
  showAll = on;
  for (const post of document.querySelectorAll(POST)) {
    if (post.dataset.ai !== "yes") continue;
    if (on) post.dataset.revealed = "yes";
    else delete post.dataset.revealed;
  }
}

// The popup asks for this tab's counts (countPosts in rules.js) and whether Show all is on,
// every second while it's open; its Show all button sends showAll and gets the same reply.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "showAll") setShowAll(!!message.on);
  if (message?.type === "counts" || message?.type === "showAll") {
    sendResponse({ ...countPosts([...document.querySelectorAll(POST)].map((post) => post.dataset)), showAll });
  }
});

const loadSettings = () => chrome.storage.local.get(["hideAI", "hideAds"]).then(apply);
loadSettings();
chrome.storage.onChanged.addListener(loadSettings);
// LinkedIn adds posts as you scroll. After the extension is reloaded or updated, this old
// copy of the script can't reach it anymore, so it stops quietly until the tab is refreshed.
const timer = setInterval(() => {
  if (!chrome.runtime?.id) return clearInterval(timer);
  if (hideAI || hideAds) scan();
}, 1000);

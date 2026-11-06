import {
  env,
  AutoTokenizer,
  AutoModelForSequenceClassification,
  AutoProcessor,
  AutoModelForImageClassification,
  RawImage,
} from "./lib/transformers.min.js";
import { detect } from "./detect.js"; // turns the scores into the reply; THRESHOLD is there
import { createWaits } from "./wait.js"; // the retry wait after a model fails, shared by all tabs

// MV3 blocks remote code, so load the ONNX runtime from the extension itself.
env.backends.onnx.wasm.wasmPaths = {
  wasm: chrome.runtime.getURL("lib/ort-wasm-simd-threaded.asyncify.wasm"),
};

const TEXT_MODEL = "MedAliFarhat/ai-text-detector-onnx"; // RoBERTa, ~125 MB, English only
// The corrected upstream release (July 2026); older copies of this model have wrong weights.
const IMAGE_MODEL = "buildborderless/CommunityForensics-DeepfakeDet-ViT"; // ViT-Small, ~87 MB

// ---------- Badge: shows "ON" while either popup switch is on ----------

// Whether a storage change flipped a popup switch. The badge and the retry wait react only to
// these keys: this worker's own storage.session writes (the wait) fire onChanged too.
const flippedSwitch = (changes) => "hideAI" in changes || "hideAds" in changes;

async function updateBadge() {
  const { hideAI, hideAds } = await chrome.storage.local.get(["hideAI", "hideAds"]);
  chrome.action.setBadgeText({ text: hideAI || hideAds ? "ON" : "" });
}
chrome.storage.onChanged.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);

// ---------- Detection: models load on first use; the browser caches the downloads ----------

let textModel, imageModel;

async function textScore(text) {
  textModel ??= Promise.all([
    AutoTokenizer.from_pretrained(TEXT_MODEL),
    AutoModelForSequenceClassification.from_pretrained(TEXT_MODEL, { dtype: "q8" }),
  ]).catch((err) => {
    textModel = null; // retry the download next time
    throw err;
  });
  const [tokenizer, model] = await textModel;
  // The model was trained on single-line plain text. Unicode "bold" letters become plain ones.
  text = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  // RoBERTa reads at most 512 tokens; longer posts would crash the model.
  const { logits } = await model(tokenizer(text, { truncation: true, max_length: 512 }));
  const [human, ai] = logits.data; // labels: 0 = Human, 1 = AI
  return 1 / (1 + Math.exp(human - ai)); // softmax over the two labels gives P(AI)
}

async function imageScore(url) {
  imageModel ??= Promise.all([
    AutoProcessor.from_pretrained(IMAGE_MODEL),
    AutoModelForImageClassification.from_pretrained(IMAGE_MODEL, { dtype: "fp32" }),
  ]).catch((err) => {
    imageModel = null;
    throw err;
  });
  const [processor, model] = await imageModel; // a failed download rejects: detect.js fails the post
  // An image that can't be fetched (dead link, expired URL) is skipped, not retried: null.
  const image = await RawImage.fromURL(url).catch((err) => {
    console.warn("AI Content Toggle: skipping an image that can't be fetched", url, err);
    return null;
  });
  if (!image) return null;
  const { logits } = await model(await processor(image));
  return 1 / (1 + Math.exp(-logits.data[0])); // one logit; sigmoid gives P(AI)
}

// ---------- Retry wait: one per model, shared by all tabs, kept across worker restarts ----------

const waits = createWaits(chrome.storage.session);

// A scoring function that keeps its model's wait: a failure starts or lengthens it, a success ends it.
function tracked(model, score) {
  return async (input) => {
    try {
      const result = await score(input);
      await waits.succeeded(model);
      return result;
    } catch (err) {
      await waits.failed(model, Date.now());
      throw err;
    }
  };
}
const scorers = { textScore: tracked("text", textScore), imageScore: tracked("image", imageScore) };

// While a model the post needs is waiting, reply null at once without touching any model:
// content.js marks the post "error" and asks again later, as after a failed download.
async function check(msg) {
  const needs = [msg.text && "text", msg.images.length && "image"].filter(Boolean);
  for (const model of needs) if (!(await waits.ready(model, Date.now()))) return null;
  return detect(msg, scorers);
}

let queue = Promise.resolve(); // run one detection at a time

// Flipping either switch tries the models again right away (content.js resets each tab's own
// wait). Only those keys (see flippedSwitch). In the queue, so a check already running can't
// set the wait again after the reset.
chrome.storage.onChanged.addListener((changes) => {
  if (flippedSwitch(changes)) queue = queue.then(() => waits.reset()).catch(console.warn);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "detect") return;
  const job = queue.then(() => check(msg));
  queue = job.catch(() => {});
  // Extension API calls keep the service worker alive during long model downloads.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  job
    .then(sendResponse, (err) => {
      console.warn(err);
      sendResponse(null);
    })
    .finally(() => clearInterval(keepAlive));
  return true; // we reply asynchronously
});

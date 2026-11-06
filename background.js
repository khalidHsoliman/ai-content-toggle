import {
  env,
  AutoTokenizer,
  AutoModelForSequenceClassification,
  AutoProcessor,
  AutoModelForImageClassification,
  RawImage,
} from "./lib/transformers.min.js";
import { detect } from "./detect.js"; // turns the scores into the reply; THRESHOLD is there

// MV3 blocks remote code, so load the ONNX runtime from the extension itself.
env.backends.onnx.wasm.wasmPaths = {
  wasm: chrome.runtime.getURL("lib/ort-wasm-simd-threaded.asyncify.wasm"),
};

const TEXT_MODEL = "MedAliFarhat/ai-text-detector-onnx"; // RoBERTa, ~125 MB, English only
// The corrected upstream release (July 2026); older copies of this model have wrong weights.
const IMAGE_MODEL = "buildborderless/CommunityForensics-DeepfakeDet-ViT"; // ViT-Small, ~87 MB

// ---------- Badge: shows "ON" while either popup switch is on ----------

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

let queue = Promise.resolve(); // run one detection at a time

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "detect") return;
  const job = queue.then(() => detect(msg, { textScore, imageScore }));
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

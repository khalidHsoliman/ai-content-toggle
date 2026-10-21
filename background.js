import {
  env,
  AutoTokenizer,
  AutoModelForSequenceClassification,
  AutoProcessor,
  AutoModelForImageClassification,
  RawImage,
} from "./lib/transformers.min.js";

// MV3 blocks remote code, so load the ONNX runtime from the extension itself.
env.backends.onnx.wasm.wasmPaths = {
  wasm: chrome.runtime.getURL("lib/ort-wasm-simd-threaded.asyncify.wasm"),
};

const TEXT_MODEL = "MedAliFarhat/ai-text-detector-onnx"; // RoBERTa, ~125 MB, English only
// The corrected upstream release (July 2026); older copies of this model have wrong weights.
const IMAGE_MODEL = "buildborderless/CommunityForensics-DeepfakeDet-ViT"; // ViT-Small, ~87 MB
const THRESHOLD = 0.9; // flag only when the model is quite sure; lower it to hide more

// ---------- Toggle: clicking the toolbar icon flips the switch ----------

chrome.action.onClicked.addListener(async () => {
  const { hideAI = false } = await chrome.storage.local.get("hideAI");
  await chrome.storage.local.set({ hideAI: !hideAI });
  updateBadge(!hideAI);
});

function updateBadge(hidden) {
  chrome.action.setBadgeText({ text: hidden ? "OFF" : "" });
}

async function restoreBadge() {
  const { hideAI = false } = await chrome.storage.local.get("hideAI");
  updateBadge(hideAI);
}
chrome.runtime.onStartup.addListener(restoreBadge);
chrome.runtime.onInstalled.addListener(restoreBadge);

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
  const [processor, model] = await imageModel;
  const { logits } = await model(await processor(await RawImage.fromURL(url)));
  return 1 / (1 + Math.exp(-logits.data[0])); // one logit; sigmoid gives P(AI)
}

async function detect({ text, images }) {
  const scores = [];
  if (text) scores.push(await textScore(text));
  for (const url of images) {
    scores.push(await imageScore(url).catch((err) => (console.warn(err), 0)));
  }
  const score = Math.max(0, ...scores);
  return { score, isAI: score >= THRESHOLD };
}

let queue = Promise.resolve(); // run one detection at a time

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "detect") return;
  const job = queue.then(() => detect(msg));
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

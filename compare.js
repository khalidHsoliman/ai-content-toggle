import { env, AutoTokenizer, AutoModelForSequenceClassification } from "./lib/transformers.min.js";

env.backends.onnx.wasm.wasmPaths = {
  wasm: chrome.runtime.getURL("lib/ort-wasm-simd-threaded.asyncify.wasm"),
};

// A much larger detector (DeBERTa-v3-large) to compare against. ~1.7 GB, runs only on WebGPU.
const LARGE_MODEL = "GabeuxDev/ai-text-detector-v1.01-onnx";
const THRESHOLDS = [0.5, 0.7, 0.9];

const $ = (id) => document.getElementById(id);
const status = (text) => ($("status").textContent = text);
const percent = (score) => (score == null ? "–" : `${Math.round(score * 100)}%`);

// Posts are separated by a line with just ===, and each starts with a line saying AI or Human.
function parse(input) {
  return input
    .split(/^===\s*$/m)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, i) => {
      const [first, ...rest] = block.split("\n");
      const label = first.trim().toLowerCase();
      if (label !== "ai" && label !== "human") {
        throw new Error(`Post ${i + 1} doesn't start with a line saying AI or Human.`);
      }
      return { label: label === "ai" ? "AI" : "Human", text: rest.join("\n").trim() };
    });
}

// The model the extension uses now, through the background worker.
async function currentScore(text) {
  const result = await chrome.runtime.sendMessage({ type: "detect", text, images: [] });
  if (!result) throw new Error("The current model failed. Check the service worker console.");
  return result.score;
}

let large;
async function largeScore(text) {
  large ??= (async () => {
    if (!(await navigator.gpu?.requestAdapter())) {
      throw new Error("This browser can't use WebGPU, which the large model needs.");
    }
    const progress_callback = (p) => {
      if (p.status === "progress" && p.total > 50e6) {
        status(`Downloading the large model: ${Math.round(p.progress)}% (one time only)`);
      }
    };
    return Promise.all([
      AutoTokenizer.from_pretrained(LARGE_MODEL),
      AutoModelForSequenceClassification.from_pretrained(LARGE_MODEL, {
        dtype: "fp32",
        device: "webgpu",
        progress_callback,
      }),
    ]);
  })().catch((err) => {
    large = null;
    throw err;
  });
  const [tokenizer, model] = await large;
  const { logits } = await model(tokenizer(text, { truncation: true, max_length: 768 }));
  return 1 / (1 + Math.exp(-logits.data[0])); // one logit; sigmoid gives P(AI)
}

function summarize(rows, key, name, seconds) {
  const ai = rows.filter((r) => r.label === "AI");
  const human = rows.filter((r) => r.label === "Human");
  const lines = THRESHOLDS.map((t) => {
    const caught = ai.filter((r) => r[key] >= t).length;
    const wrong = human.filter((r) => r[key] >= t).length;
    return `At ${t * 100}%: catches ${caught} of ${ai.length} AI posts, wrongly flags ${wrong} of ${human.length} human posts`;
  });
  const div = document.createElement("div");
  div.innerHTML = `<b></b> (about ${seconds.toFixed(1)} s per post)`;
  div.querySelector("b").textContent = name;
  $("summary").append(div, ...lines.map((line) => Object.assign(document.createElement("div"), { textContent: line })));
}

// The style rules (style.js) give yes or no, so there's one line instead of one per threshold.
function summarizeStyle(rows) {
  const flagged = (label) => rows.filter((r) => r.label === label && r.style.points >= STYLE_MIN_POINTS).length;
  const count = (label) => rows.filter((r) => r.label === label).length;
  const div = document.createElement("div");
  div.innerHTML = "<b>Style rules</b> (the extension flags these without running a model)";
  $("summary").append(
    div,
    Object.assign(document.createElement("div"), {
      textContent: `Catches ${flagged("AI")} of ${count("AI")} AI posts, wrongly flags ${flagged("Human")} of ${count("Human")} human posts`,
    })
  );
}

const styleCell = ({ points, hits }) => (points >= STYLE_MIN_POINTS ? `AI-style: ${hits.join(", ")}` : hits.join(", ") || "–");

function render(rows) {
  const body = $("results").querySelector("tbody");
  body.replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement("tr");
      for (const [value, cls] of [[r.label], [percent(r.current), "num"], [percent(r.large), "num"], [styleCell(r.style)], [r.text.slice(0, 90)]]) {
        const td = document.createElement("td");
        td.textContent = value;
        if (cls) td.className = cls;
        tr.append(td);
      }
      return tr;
    })
  );
  $("results").hidden = false;
}

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  $("summary").replaceChildren();
  try {
    const rows = parse($("input").value);
    if (!rows.length) throw new Error("Paste some posts first.");
    for (const row of rows) row.style = aiStyle(row.text); // instant, so before the models run
    const useLarge = $("useLarge").checked;
    // Timing skips the first post, which includes loading (and maybe downloading) the models.
    const time = { current: 0, large: 0 };
    const timed = (i, key, start) => i > 0 && (time[key] += performance.now() - start);
    for (const [i, row] of rows.entries()) {
      status(`Scoring post ${i + 1} of ${rows.length}…`);
      let start = performance.now();
      row.current = await currentScore(row.text);
      timed(i, "current", start);
      if (useLarge) {
        start = performance.now();
        row.large = await largeScore(row.text);
        timed(i, "large", start);
      }
      render(rows);
    }
    const perPost = (key) => time[key] / Math.max(rows.length - 1, 1) / 1000;
    summarize(rows, "current", "Current model", perPost("current"));
    if (useLarge) summarize(rows, "large", "Large model", perPost("large"));
    summarizeStyle(rows);
    status(`Done: ${rows.length} posts scored.`);
  } catch (err) {
    status(err.message);
  } finally {
    $("run").disabled = false;
  }
});

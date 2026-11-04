// Final check for the style-rule fixes and the middle band. Plain Node, no dependencies.
// Usage: node verify-band.js /workspace/ai-content-toggle
// Each check prints PASS or FAIL; a missing file or function counts as a FAIL, not a crash.
const fs = require("fs"), path = require("path"), vm = require("vm"), { spawnSync } = require("child_process");
const dir = path.resolve(process.argv[2] || ".");
const has = (f) => fs.existsSync(path.join(dir, f));
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const results = [];
const check = (name, fn) => {
  try {
    const out = fn();
    const ok = out === true || (out && out.ok);
    results.push({ name, ok, detail: ok ? "" : out && out.detail ? out.detail : String(out) });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message.split("\n")[0] });
  }
};
const checkAsync = async (name, fn) => {
  try {
    const out = await fn();
    const ok = out === true || (out && out.ok);
    results.push({ name, ok, detail: ok ? "" : out && out.detail ? out.detail : String(out) });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message.split("\n")[0] });
  }
};

// Plain scripts run in one fresh context, like the extension's content-script world.
function load(files, extra = {}) {
  const ctx = { console: { log() {}, warn() {} }, ...extra };
  vm.createContext(ctx);
  for (const f of files) if (has(f)) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}
const g = (ctx, name) => vm.runInContext(`typeof ${name} === "undefined" ? undefined : ${name}`, ctx);

// Made-up text only.
const long = "We moved the made up workshop to a bigger shed this spring and spent most weekends sorting tools, fixing shelves and painting the doors. ".repeat(2);

(async () => {
  // ---------- 1. style.js ----------
  const s = load(["style.js"]);
  const aiStyle = g(s, "aiStyle"), MIN = g(s, "STYLE_MIN_POINTS");
  const hits = (t) => aiStyle(t).hits;
  check("style: a plain bullet-dot list is not arrow bullets", () => !hits("List:\n\u2022 eggs\n\u2022 flour\n\u2022 jam").includes("arrow bullets") || { detail: hits("List:\n\u2022 eggs\n\u2022 flour\n\u2022 jam").join(",") });
  for (const sym of ["\u00a9", "\u00ae", "\u2122", "\u25aa", "\u25ab"]) {
    check(`style: two lines starting with U+${sym.codePointAt(0).toString(16).toUpperCase()} are not arrow bullets`, () =>
      !hits(`Intro\n${sym} one made up line\n${sym} another made up line`).includes("arrow bullets"));
  }
  check("style: real emoji bullets still count", () => hits("Intro\n\u2705 first\n\ud83d\udc49 second").includes("arrow bullets"));
  check("style: one em dash plus a closing question stays under the threshold", () => {
    const p = aiStyle("Widgets \u2014 are they worth it?").points;
    return p < MIN || { detail: `${p} points, min ${MIN}` };
  });
  check("style: an em dash with a stock phrase still flags", () => aiStyle("Here's what I learned \u2014 widgets.").points >= MIN);
  check("style: markdown alone still flags", () => aiStyle("Some **bold words** here.").points >= MIN);
  check("style: \"Second thoughts?\" mid-post is not a closing question", () => !hits("Second thoughts? Never. The made up bakery was the right call.").includes("closing question"));
  check("style: \"disagree?\" is not a closing question", () => !hits("Would anyone disagree? My brother, probably. The roof leaked.").includes("closing question"));
  check("style: \"Thoughts?\" before a call to action still counts", () => hits("Small habits compound.\n\nThoughts? Drop them below.").includes("closing question"));

  // ---------- 2. aiVerdict in rules.js ----------
  const r = load(["style.js", "rules.js"]);
  const aiVerdict = g(r, "aiVerdict");
  const R = (score, isAI = score >= 0.9) => ({ score, isAI });
  check("aiVerdict exists", () => typeof aiVerdict === "function" || { detail: "not defined" });
  check("aiVerdict: 0.7 + 2 points, no images -> band", () => aiVerdict(2, R(0.7), false) === "band");
  check("aiVerdict: band starts at exactly 0.5", () => aiVerdict(2, R(0.5), false) === "band" && aiVerdict(2, R(0.49), false) === "");
  check("aiVerdict: 1 point is not enough for the band", () => aiVerdict(1, R(0.85), false) === "");
  check("aiVerdict: no band with images", () => aiVerdict(2, R(0.7), true) === "");
  check("aiVerdict: the model alone (isAI) flags", () => aiVerdict(0, R(0.95), true) === "model");
  check("aiVerdict: 3+ points flag with no model result", () => aiVerdict(3, null) === "style");
  check("aiVerdict: under 3 points with no model result doesn't flag", () => aiVerdict(2, null) === "" && aiVerdict(0, null) === "");

  // ---------- 3. content.js wiring on a fake page ----------
  function post({ text = long, images = [], posters = [] } = {}) {
    const p = { dataset: {}, text, onScreen: true };
    p.querySelectorAll = (sel) => {
      if (sel === "*") return [];
      if (sel === "img") return images.map((src) => ({ src }));
      if (sel === "video[poster]") return posters.map((poster) => ({ poster }));
      if (sel.includes("expandable") && p.text) return [{ innerText: p.text, closest: () => null }];
      return [];
    };
    return p;
  }
  function page(posts, model) {
    let now = 0, tick;
    const sent = [], watching = new Set();
    let pending = null;
    const ctx = {
      console: { log() {}, warn() {} },
      setInterval: (fn) => ((tick = fn), 1), clearInterval() {},
      document: { querySelectorAll: () => posts, documentElement: { classList: { toggle() {} } }, addEventListener() {} },
      IntersectionObserver: class {
        constructor(cb) { this.cb = cb; }
        observe(t) {
          if (watching.has(t)) return; watching.add(t);
          if (!pending) setTimeout(() => { const e = pending.filter((x) => watching.has(x)).map((x) => ({ target: x, isIntersecting: true })); pending = null; if (e.length) this.cb(e); }, 0);
          (pending ??= []).push(t);
        }
        unobserve(t) { watching.delete(t); } disconnect() { watching.clear(); }
      },
      chrome: {
        runtime: { id: "x", sendMessage: async (m) => { sent.push({ t: now / 1000, m }); return model(now, m); } },
        storage: { local: { get: async () => ({ hideAI: true }) }, onChanged: { addListener() {} } },
      },
      __now: () => now,
    };
    vm.createContext(ctx);
    vm.runInContext("Date.now = () => __now();", ctx);
    for (const f of ["style.js", "rules.js", "content.js"]) if (has(f)) vm.runInContext(read(f), ctx, { filename: f });
    const flush = () => new Promise((res) => setTimeout(res, 1));
    return {
      sent,
      start: async () => { await flush(); await flush(); },
      run: async (n) => { for (let i = 0; i < n; i++) { now += 1000; tick(); await flush(); await flush(); } },
    };
  }
  const twoPts = long + "\nIs it worth it \u2014 really?"; // em dash + closing question = 2 points after the fix
  const onePt = long + "\nIs it worth it?";
  const styled = "**Key takeaways** from my made up week:\n" + long;
  const media = "https://media.licdn.com/dms/image/v2/x/feedshare-shrink_800/0/1";

  await checkAsync("wiring: 0.7 + 2 style points flags the post with a band label", async () => {
    const p1 = post({ text: twoPts }); const pg = page([p1], () => ({ score: 0.7, isAI: false }));
    await pg.start(); await pg.run(2);
    return (p1.dataset.ai === "yes" && !!p1.dataset.aiBand && !p1.dataset.aiStyle) || { detail: JSON.stringify(p1.dataset) };
  });
  await checkAsync("wiring: 0.7 + 1 style point is not flagged", async () => {
    const p1 = post({ text: onePt }); const pg = page([p1], () => ({ score: 0.7, isAI: false }));
    await pg.start(); await pg.run(2);
    return p1.dataset.ai === "no" || { detail: JSON.stringify(p1.dataset) };
  });
  await checkAsync("wiring: no band for a post with an image", async () => {
    const p1 = post({ text: twoPts, images: [media] }); const pg = page([p1], () => ({ score: 0.7, isAI: false }));
    await pg.start(); await pg.run(2);
    return (p1.dataset.ai === "no" && pg.sent.some((x) => x.m.images.length === 1)) || { detail: JSON.stringify(p1.dataset) };
  });
  await checkAsync("wiring: no band for a post with a video cover frame", async () => {
    const p1 = post({ text: twoPts, posters: [media] }); const pg = page([p1], () => ({ score: 0.7, isAI: false }));
    await pg.start(); await pg.run(2);
    return p1.dataset.ai === "no" || { detail: JSON.stringify(p1.dataset) };
  });
  await checkAsync("wiring: 3+ style points flag without sending anything to the model", async () => {
    const p1 = post({ text: styled }); const pg = page([p1], () => ({ score: 0.1, isAI: false }));
    await pg.start(); await pg.run(2);
    return (p1.dataset.ai === "yes" && !!p1.dataset.aiStyle && pg.sent.length === 0) || { detail: `${JSON.stringify(p1.dataset)}, sent ${pg.sent.length}` };
  });
  await checkAsync("wiring: model down -> a 2-point post isn't flagged; after recovery the band flags it", async () => {
    const p1 = post({ text: twoPts }); let up = false;
    const pg = page([p1], () => (up ? { score: 0.7, isAI: false } : null));
    await pg.start(); await pg.run(3);
    const during = p1.dataset.ai;
    up = true; await pg.run(10);
    return (during === "error" && p1.dataset.ai === "yes" && !!p1.dataset.aiBand) || { detail: `during=${during}, after=${JSON.stringify(p1.dataset)}` };
  });

  // ---------- 4. compare page combined line (fake DOM, stand-in model) ----------
  await checkAsync("compare: combined line skips short or non-Latin posts and says how many", async () => {
    if (!has("compare.js")) return { detail: "no compare.js" };
    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "vb-"));
    fs.mkdirSync(path.join(tmp, "lib"));
    fs.writeFileSync(path.join(tmp, "lib", "transformers.min.js"), "export const env={backends:{onnx:{wasm:{}}}}; export const AutoTokenizer={}; export const AutoModelForSequenceClassification={};");
    fs.copyFileSync(path.join(dir, "compare.js"), path.join(tmp, "compare.mjs"));
    const html = read("compare.html");
    const classic = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    const runner = `
      import fs from "node:fs"; import vm from "node:vm";
      for (const f of ${JSON.stringify(classic)}) vm.runInThisContext(fs.readFileSync(${JSON.stringify(dir)} + "/" + f, "utf8"));
      const el = () => { const e = { children: [], textContent: "", value: "", checked: false, hidden: true, listeners: {},
        addEventListener: (t, f) => (e.listeners[t] = f), append: (...c) => e.children.push(...c), replaceChildren: (...c) => (e.children = c),
        querySelector: () => (e.b ??= el()), set innerHTML(v) { e.html = v; } }; return e; };
      const els = {}; globalThis.document = { getElementById: (id) => (els[id] ??= el()), createElement: el };
      globalThis.chrome = { runtime: { getURL: (p) => p, sendMessage: async () => ({ score: 0.3, isAI: false }) } };
      await import("./compare.mjs");
      document.getElementById("input").value = ${JSON.stringify(`AI\n${long}\n===\nHuman\n${long}\n===\nAI\nShort made up post.\n===\nHuman\n\u0391\u03c5\u03c4\u03ae \u03b5\u03af\u03bd\u03b1\u03b9 \u03bc\u03b9\u03b1 \u03c6\u03c4\u03b9\u03b1\u03c7\u03c4\u03ae \u03b1\u03bd\u03ac\u03c1\u03c4\u03b7\u03c3\u03b7. `.replace(/\. $/, ". ".repeat(1)) + "\u039a\u03ae\u03c0\u03bf\u03c2 ".repeat(40))};
      await els.run.listeners.click();
      console.log(els.summary.children.map((c) => c.textContent || c.html).join("\\n"));`;
    fs.writeFileSync(path.join(tmp, "run.mjs"), runner);
    const out = spawnSync(process.execPath, [path.join(tmp, "run.mjs")], { encoding: "utf8", cwd: tmp });
    fs.rmSync(tmp, { recursive: true, force: true });
    const text = out.stdout + out.stderr;
    return /Skipped 2 of 4 posts/.test(text) || { detail: text.split("\n").filter((l) => /Skipped|Catches|Error/.test(l)).join(" | ") || "no output" };
  });

  // ---------- 5. scorer on the sample ----------
  check("scorer: sample file -> catches 4 of 5 AI, wrongly flags 0 of 5 human", () => {
    if (!has("scripts/score.js")) return { detail: "no scripts/score.js" };
    const out = spawnSync(process.execPath, [path.join(dir, "scripts/score.js"), path.join(dir, "scripts/sample-posts.txt")], { encoding: "utf8" });
    const line = out.stdout.split("\n")[1] || out.stderr.trim();
    return line === "Catches 4 of 5 AI posts, wrongly flags 0 of 5 human posts" || { detail: line };
  });

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  (" + x.detail + ")"}`);
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

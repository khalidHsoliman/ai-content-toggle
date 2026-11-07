// End-to-end check of the popup counts, collapse-again, Show all and reshare fixes: the real popup.js
// (on a fake DOM built from popup.html) talks through a fake chrome.tabs to the real content.js
// (with style.js and rules.js) running on a small fake LinkedIn page in the old layout.
// Plain Node, no dependencies, made-up text only.
// Usage: node verify-popup.js /workspace/ai-content-toggle
const fs = require("fs"), path = require("path"), vm = require("vm");
const dir = path.resolve(process.argv[2] || ".");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

// ---------- a tiny DOM: enough selectors for content.js ----------
function matchesOne(el, sel) {
  sel = sel.trim();
  if (sel === "*") return true;
  const not = sel.match(/^(.*):not\((.*)\)$/);
  if (not) return (not[1] === "" || matchesOne(el, not[1])) && !matches(el, not[2]);
  const m = sel.match(/^([a-z]+)?((?:\[[^\]]+\]|\.[\w-]+)*)$/i);
  if (!m) return false;
  if (m[1] && el.tag !== m[1].toLowerCase()) return false;
  for (const part of m[2].match(/\[[^\]]+\]|\.[\w-]+/g) ?? []) {
    if (part[0] === ".") { if (!(el.attrs.class ?? "").split(/\s+/).includes(part.slice(1))) return false; continue; }
    const a = part.match(/^\[([\w-]+)(?:([\^*]?=)"([^"]*)")?\]$/);
    const v = attr(el, a[1]);
    if (v === undefined) return false;
    if (a[2] === "=" && v !== a[3]) return false;
    if (a[2] === "^=" && !v.startsWith(a[3])) return false;
    if (a[2] === "*=" && !v.includes(a[3])) return false;
  }
  return true;
}
const attr = (el, name) => (name.startsWith("data-") ? el.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] ?? el.attrs[name] : el.attrs[name]);
const matches = (el, sel) => sel.split(",").some((s) => matchesOne(el, s));
function el(tag, attrs = {}, children = [], text = "") {
  const e = { tag, attrs, dataset: {}, children, parent: null, ownText: text };
  for (const c of children) c.parent = e;
  e.matches = (sel) => matches(e, sel);
  e.closest = (sel) => { for (let n = e; n; n = n.parent) if (n.matches(sel)) return n; return null; };
  e.querySelectorAll = (sel) => { const out = []; const walk = (n) => n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); }); walk(e); return out; };
  Object.defineProperty(e, "textContent", { get: () => [e.ownText, ...e.children.map((c) => c.textContent)].filter(Boolean).join(" ") });
  Object.defineProperty(e, "innerText", { get: () => e.textContent });
  Object.defineProperty(e, "src", { get: () => e.attrs.src });
  return e;
}
let urn = 0;
const media = (name) => `https://media.licdn.com/dms/image/v2/made-up-${name}/feedshare-shrink_800/0/1`;
const textBox = (text) => el("div", { class: "update-components-text" }, [], text);
const post = ({ text = "", image, promoted, inner } = {}) =>
  el("div", { "data-urn": `urn:li:activity:${++urn}` }, [
    el("span", {}, [], "Made Up Name"),
    ...(promoted ? [el("span", {}, [], "Promoted")] : []),
    ...(text ? [textBox(text)] : []),
    ...(image ? [el("img", { src: media(image) })] : []),
    ...(inner ? [el("div", { class: "wrapper" }, [inner])] : []),
  ]);
const filler = " We moved the made up workshop to a bigger shed and spent the weekend sorting tools and paint.".repeat(3);
const T = {
  human: "A made up note about our garden shed." + filler,
  modelAI: "MODEL-AI made up text." + filler,
  styled: "**Key takeaways** from my made up week." + filler,
  band: "BAND made up text." + filler + "\nIs it worth it \u2014 really?",
};

// ---------- one LinkedIn tab running the real content.js ----------
function tab(posts) {
  let listener, timer;
  const sent = [];
  const root = el("html", {}, posts);
  const pending = new Set();
  const ctx = {
    console: { log() {}, warn() {} }, setTimeout,
    setInterval: (fn) => ((timer = fn), 1), clearInterval() {},
    document: {
      querySelectorAll: (sel) => root.querySelectorAll(sel),
      documentElement: { classList: { toggle() {} } },
      addEventListener: (type, fn) => { if (type === "click") ctx.__click = fn; },
    },
    IntersectionObserver: class {
      constructor(cb) { this.cb = cb; this.w = new Set(); }
      observe(t) { if (this.w.has(t)) return; this.w.add(t); setTimeout(() => this.w.has(t) && this.cb([{ target: t, isIntersecting: true }]), 0); }
      unobserve(t) { this.w.delete(t); } disconnect() { this.w.clear(); }
    },
    chrome: {
      runtime: {
        id: "x",
        // Stand-in models: the text model knows MODEL-AI (0.95) and BAND (0.7); images named
        // inner-ai score 0.95; an image named broken fails the check.
        sendMessage: async (m) => {
          sent.push(m);
          if (m.images.some((u) => u.includes("broken"))) return null;
          const textScore = m.text ? (m.text.includes("MODEL-AI") ? 0.95 : m.text.includes("BAND") ? 0.7 : 0.2) : null;
          const score = Math.max(textScore ?? 0, ...m.images.map((u) => (u.includes("inner-ai") ? 0.95 : 0.1)));
          return { score, isAI: score >= 0.9, textScore };
        },
        onMessage: { addListener: (f) => (listener = f) },
      },
      storage: { local: { get: async () => ({ hideAI: true, hideAds: true }), set() { throw new Error("content.js wrote to storage"); } }, onChanged: { addListener() {} } },
    },
  };
  vm.createContext(ctx);
  for (const f of ["style.js", "rules.js", "content.js"]) vm.runInContext(read(f), ctx, { filename: f });
  const t = {
    root, sent, posts,
    get listening() { return !!listener; },
    add: (p) => { posts.push(p); p.parent = root; },
    scan: async () => { timer && timer(); await settle(); },
    click: (target) => { const e = { target, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, stopPropagation() {} }; ctx.__click?.(e); return e; },
    message: (m) => new Promise((res, rej) => {
      if (!listener) return rej(new Error("Could not establish connection. Receiving end does not exist."));
      let answered = false;
      listener(m, {}, (r) => { answered = true; res(r); });
      if (!answered) res(undefined);
    }),
  };
  return t;
}
const flush = () => new Promise((r) => setTimeout(r, 1));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

// ---------- the popup, on a fake DOM from popup.html ----------
function popup(activeTab) {
  const html = read("popup.html");
  const els = {}, intervals = [], sets = [];
  const node = (id) => (els[id] ??= { id, hidden: html.match(new RegExp(`id="${id}"[^>]*\\shidden`)) !== null, disabled: false, checked: false, textContent: "", listeners: {}, dataset: {}, addEventListener(t, f) { this.listeners[t] = f; } });
  for (const [, id] of html.matchAll(/id="([\w-]+)"/g)) node(id);
  const switches = [...html.matchAll(/<input[^>]*role="switch"[^>]*id="(\w+)"/g)].map(([, id]) => node(id));
  const cells = [...html.matchAll(/data-count="(\w+)"/g)].map(([, key]) => ({ dataset: { count: key }, textContent: "" }));
  const stored = { hideAI: true, hideAds: true };
  const ctx = {
    console, setTimeout, setInterval: (fn) => (intervals.push(fn), intervals.length),
    document: {
      getElementById: (id) => els[id] ?? null,
      querySelectorAll: (sel) => (sel.includes('role="switch"') ? switches : sel === "[data-count]" ? cells : []),
    },
    chrome: {
      storage: { local: { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys ?? stored)).map((k) => [k, stored[k]])), set: async (o) => (sets.push(o), Object.assign(stored, o)) } },
      tabs: { query: async () => (activeTab ? [{ id: 1 }] : []), sendMessage: (_id, m) => activeTab.message(m), create() {} },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  return {
    els, sets,
    count: (key) => { const c = cells.find((x) => x.dataset.count === key); return c ? String(c.textContent) : "(no row)"; },
    tick: async () => { for (const fn of intervals) fn(); await settle(); },
    press: async (id) => { els[id].listeners.click?.(); await settle(); },
    flip: async (id, on) => { els[id].checked = on; els[id].listeners.change?.(); await settle(); },
  };
}

// ---------- checks ----------
const results = [];
const check = async (name, fn) => {
  try { const out = await fn(); results.push({ name, ok: out === true, detail: out === true ? "" : out }); }
  catch (err) { results.push({ name, ok: false, detail: err.message.split("\n")[0] }); }
};

(async () => {
  // A page with one post of each kind.
  const P = {
    human: post({ text: T.human }),
    model: post({ text: T.modelAI }),
    style: post({ text: T.styled }),
    band: post({ text: T.band }),
    ad: post({ text: T.human, promoted: true }),
    failed: post({ image: "broken" }),
  };
  const t = tab(Object.values(P));
  await settle(); await t.scan();
  const marks = () => Object.entries(P).map(([k, p]) => `${k}:${p.dataset.ai ?? "-"}${p.dataset.ad === "yes" ? "+ad" : ""}`).join(" ");

  await check("content.js answers the counts message with countPosts of the page", async () => {
    const r = await t.message({ type: "counts" });
    const want = { posts: 6, checked: 4, checking: 0, failed: 1, model: 1, style: 1, band: 1, revealed: 0, ads: 1, showAll: false };
    return JSON.stringify(r) === JSON.stringify(want) || `got ${JSON.stringify(r)} (marks ${marks()})`;
  });

  let pop;
  try { pop = popup(t); } catch (err) { pop = null; console.log(`(popup.js could not start on this fake: ${err.message.split("\n")[0]})`); }
  await settle();
  await check("the popup shows this tab's counts in its rows", async () => {
    const got = ["posts", "checked", "failed", "model", "style", "band", "revealed", "ads"].map((k) => `${k}=${pop.count(k)}`).join(" ");
    return (got === "posts=6 checked=4 failed=1 model=1 style=1 band=1 revealed=0 ads=1" && pop.els.counts.hidden === false && pop.els["no-counts"].hidden === true) || got;
  });

  await check("click the collapsed bar, then the thin bar: opens, then collapses again, and the count follows", async () => {
    t.click(P.model); await pop.tick(); const open = `${P.model.dataset.revealed}/${pop.count("revealed")}`;
    t.click(P.model); await pop.tick(); const closed = `${P.model.dataset.revealed ?? "-"}/${pop.count("revealed")}`;
    return (open === "yes/1" && closed === "-/0") || `after 1st click ${open}, after 2nd ${closed}`;
  });

  await check("a click inside an open post (on its text) is left to LinkedIn", async () => {
    t.click(P.style);
    const e = t.click(P.style.children.find((c) => c.attrs.class === "update-components-text"));
    const stillOpen = P.style.dataset.revealed === "yes" && !e.defaultPrevented;
    t.click(P.style); // collapse it again for the next checks
    return stillOpen || `revealed=${P.style.dataset.revealed}, prevented=${e.defaultPrevented}`;
  });

  await check("Show all opens every flagged post (not ads), the button flips, and the count follows", async () => {
    await pop.press("show-all");
    const open = Object.entries(P).filter(([, p]) => p.dataset.revealed).map(([k]) => k).join(",");
    return (open === "model,style,band" && pop.count("revealed") === "3" && /Collapse all/.test(pop.els["show-all"].textContent)) || `open: ${open}, revealed=${pop.count("revealed")}, button "${pop.els["show-all"].textContent}"`;
  });

  await check("with Show all on, a post flagged later arrives open", async () => {
    const late = post({ text: T.styled }); t.add(late); P.late = late; // style-flagged, so the retry wait after the failed post doesn't matter
    await t.scan();
    return (late.dataset.ai === "yes" && late.dataset.revealed === "yes") || `late post: ai=${late.dataset.ai}, revealed=${late.dataset.revealed}`;
  });

  await check("with Show all on, a post the model flags later also arrives open", async () => {
    const m = tab([post({ text: T.human })]); await settle(); await m.scan();
    await m.message({ type: "showAll", on: true });
    const late = post({ text: T.modelAI }); m.add(late);
    await m.scan();
    return (late.dataset.ai === "yes" && late.dataset.revealed === "yes") || `late post: ai=${late.dataset.ai}, revealed=${late.dataset.revealed}`;
  });

  await check("Collapse all collapses them all and the button flips back", async () => {
    await pop.press("show-all");
    const open = Object.entries(P).filter(([, p]) => p.dataset.revealed).map(([k]) => k);
    return (open.length === 0 && pop.count("revealed") === "0" && /Show all/.test(pop.els["show-all"].textContent)) || `still open: ${open.join(",")}`;
  });

  await check("clicks and Show all write nothing to chrome.storage", async () => pop.sets.length === 0 || `popup wrote ${JSON.stringify(pop.sets)}`);

  await check("Hide AI posts off in the popup: saved, its note shows, and Show all is disabled", async () => {
    await pop.flip("hideAI", false);
    const ok = JSON.stringify(pop.sets) === '[{"hideAI":false}]' && pop.els["ai-off"].hidden === false && pop.els["show-all"].disabled === true;
    await pop.flip("hideAI", true);
    return ok || `sets ${JSON.stringify(pop.sets)}, note hidden=${pop.els["ai-off"].hidden}, disabled=${pop.els["show-all"].disabled}`;
  });

  await check("a tab with no content script: only the no-counts line, no button", async () => {
    const quiet = { message: () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")) };
    const p2 = popup(quiet); await settle();
    return (p2.els["no-counts"].hidden === false && p2.els.counts.hidden === true && p2.els["show-all"].hidden === true) || `no-counts hidden=${p2.els["no-counts"].hidden}, counts hidden=${p2.els.counts.hidden}, button hidden=${p2.els["show-all"].hidden}`;
  });

  // Reshares, on their own pages.
  await check("bare reshare of an AI post: only the inner post is flagged, counted once, sent once", async () => {
    const inner = post({ text: T.modelAI }), outer = post({ inner });
    const r = tab([outer]); // the inner post sits inside the outer one, as on the page
    await settle(); await r.scan();
    const c = await r.message({ type: "counts" });
    const sentAI = r.sent.filter((m) => m.text.includes("MODEL-AI")).length;
    return (outer.dataset.ai === "no" && inner.dataset.ai === "yes" && c.model === 1 && sentAI === 1) || `outer=${outer.dataset.ai}, inner=${inner.dataset.ai}, model count ${c.model}, AI text sent ${sentAI}x`;
  });

  await check("reshare with an AI image in the inner post: the outer post doesn't send it and isn't flagged", async () => {
    const inner = post({ text: T.human, image: "inner-ai" }), outer = post({ text: "A made up note from the resharer." + filler, image: "own", inner });
    const r = tab([outer]);
    await settle(); await r.scan();
    const outerMsg = r.sent.find((m) => m.text.includes("resharer"));
    return (outer.dataset.ai === "no" && inner.dataset.ai === "yes" && outerMsg && outerMsg.images.every((u) => !u.includes("inner-ai"))) || `outer=${outer.dataset.ai}, inner=${inner.dataset.ai}, outer sent ${JSON.stringify(outerMsg?.images)}`;
  });

  await check("reshared Promoted post: only the inner post is an ad", async () => {
    const inner = post({ text: T.human, promoted: true }), outer = post({ text: "A made up note from the resharer." + filler, inner });
    const r = tab([outer]);
    await settle(); await r.scan();
    const c = await r.message({ type: "counts" });
    return (inner.dataset.ad === "yes" && outer.dataset.ad !== "yes" && c.ads === 1) || `outer ad=${outer.dataset.ad}, inner ad=${inner.dataset.ad}, ads count ${c.ads}`;
  });

  await check("styles.css: ads stay hidden whatever data-revealed says, and the thin bar exists", async () => {
    const css = read("styles.css");
    const adRule = /html\.hide-ads \[data-ad="yes"\]\s*,/.test(css) && !/\[data-ad="yes"\]:not\(\[data-revealed\]\)/.test(css);
    const thin = /\[data-ai="yes"\]\[data-revealed\]::before[^}]*content:/.test(css);
    return (adRule && thin) || `ad rule ok=${adRule}, thin bar rule=${thin}`;
  });

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  (" + r.detail + ")"}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

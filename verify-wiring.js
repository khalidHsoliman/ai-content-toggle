// Checks the content.js wiring that the node --test suite can't reach: the retry wait,
// style flags during the wait, ads walked once, late-filled ads, hidden ads skipping the model,
// the middle band (aiVerdict in rules.js) before and after the model, the popup's counts message,
// clicking a bar to open a post and collapse it again, the popup's Show all button (and its end
// when LinkedIn moves to another page), and reshares.
// Runs style.js, rules.js and content.js together with a fake page, clock and chrome API.
// Usage: node verify-wiring.js /workspace/ai-content-toggle
const fs = require("fs"), path = require("path"), vm = require("vm");
const dir = path.resolve(process.argv[2] || ".");
const files = ["style.js", "rules.js", "content.js"].filter((f) => fs.existsSync(path.join(dir, f)));

const long = "plain made up words about garden sheds and weekend plans ".repeat(5); // 290 chars
const styled = "**Key takeaways** from my made up week:\n" + long;
const leaf = (text) => ({ children: [], textContent: text, closest: () => null });

// The element.matches() content.js uses on click targets, and the :not() in styles.css: attribute
// selectors, with :not(...) negating the whole group inside it. data-x-y is dataset.xY.
function matches(dataset, selector) {
  const key = (name) => name.replace(/^data-/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase());
  const all = (compound) => {
    const parts = [...compound.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    if (!parts.length || compound.replace(/\[[^\]]*\]/g, "")) throw new Error(`fake matches() doesn't know ${selector}`);
    return parts.every(([, name, value]) => (value === undefined ? key(name) in dataset : dataset[key(name)] === value));
  };
  const base = selector.replace(/:not\([^)]*\)/g, "");
  return (base === "" || all(base)) && [...selector.matchAll(/:not\(([^)]*)\)/g)].every(([, group]) => !all(group));
}

// nested: posts inside this one, like a reshare's inner post in LinkedIn's old layout. Like the
// DOM, querySelectorAll also returns what's in them, and closest(POST) on anything returned
// gives the post it's directly in. The page's list (document.querySelectorAll) names them too.
function post({ text = long, labels = ["Made Up Name"], onScreen = true, images = [], nested = [] } = {}) {
  const p = { dataset: {}, text, els: labels.map(leaf), onScreen, walks: 0, nested };
  for (const n of nested) n.outer = p;
  p.matches = (selector) => matches(p.dataset, selector);
  // Something inside the post (a link, the like button): its own dataset, not a post.
  p.child = { dataset: {}, matches: (selector) => matches(p.child.dataset, selector) };
  const own = (el) => Object.assign(el, { closest: (sel) => (sel.includes("urn:li:activity") ? p : null) });
  p.querySelectorAll = (sel) => {
    const inner = nested.flatMap((n) => n.querySelectorAll(sel));
    if (sel === "*") return p.walks++, [...p.els.map(own), ...inner];
    if (sel === "img") return [...images.map((src) => own({ src })), ...inner];
    if (sel.includes("expandable")) return [...(p.text ? [own({ innerText: p.text })] : []), ...inner];
    return inner;
  };
  Object.defineProperty(p, "textContent", {
    get: () => [p.text, ...p.els.map((e) => e.textContent), ...nested.map((n) => n.textContent)].join(" ").trim(),
  });
  return p;
}

// One fresh page per scenario. model: (now, message) => true (works, score 0.1), false (fails),
// or the reply itself, like { score: 0.7, isAI: false }.
function page(posts, settings, model) {
  let now = 0, tick, onChange, onMessage, onClick;
  const sent = [];
  const watching = new Set();
  let observer;
  const ctx = {
    console: { log() {}, warn() {} },
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval() {},
    document: { querySelectorAll: () => posts, documentElement: { classList: { toggle() {} } }, addEventListener: (type, fn) => type === "click" && (onClick = fn),
      location: { pathname: "/feed/", search: "", hash: "" } },
    // Like the browser: the first notification comes after the current task, and a post
    // hidden by styles.css (an ad while Hide ads is on) has no box, so it never intersects.
    IntersectionObserver: class {
      constructor(cb) { this.cb = cb; observer = this; }
      observe(t) {
        if (watching.has(t)) return;
        watching.add(t);
        t.observed = (t.observed ?? 0) + 1;
        // Like the browser, new observations are delivered together in one callback.
        if (!this.pending) setTimeout(() => {
          const entries = this.pending.filter((x) => watching.has(x))
            .map((x) => ({ target: x, isIntersecting: x.onScreen && !(settings.hideAds && x.dataset.ad === "yes") }));
          this.pending = null;
          if (entries.length) this.cb(entries);
        }, 0);
        (this.pending ??= []).push(t);
      }
      unobserve(t) { watching.delete(t); }
      disconnect() { watching.clear(); }
    },
    chrome: {
      runtime: { id: "x", sendMessage: async (m) => {
        sent.push({ t: now / 1000, m });
        const reply = model(now, m);
        return reply === true ? { isAI: false, score: 0.1 } : reply || null;
      }, onMessage: { addListener: (fn) => (onMessage = fn) } },
      // No set(): content.js must never write to storage (it reloads its settings on every change).
      storage: { local: { get: async () => ({ ...settings }), set() { throw new Error("content.js wrote to storage"); } }, onChanged: { addListener: (fn) => (onChange = fn) } },
    },
    __now: () => now,
  };
  vm.createContext(ctx);
  vm.runInContext("Date.now = () => __now();", ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
  const flush = () => new Promise((r) => setTimeout(r, 1));
  return {
    sent, watching,
    start: async () => { await flush(); await flush(); }, // settings load, first scan, first observer callback
    // The browser reporting that a watched post scrolled into view.
    async scrollIn(t) { t.onScreen = true; observer.cb([{ target: t, isIntersecting: !(settings.hideAds && t.dataset.ad === "yes") }]); await flush(); await flush(); },
    async run(seconds) { for (let i = 0; i < seconds; i++) { now += 1000; tick(); await flush(); await flush(); } },
    // LinkedIn moving to another page without reloading: only the location changes.
    navigate(to) { Object.assign(ctx.document.location, to); },
    async change(next) { Object.assign(settings, next); onChange(); await flush(); await flush(); },
    // The popup's message, as chrome.tabs.sendMessage delivers it: { answered, reply, kept } (kept: returned true).
    // A click, as the capture listener on document sees it: { stopped } (default prevented and stopped).
    click(target) {
      let prevented = false, stopped = false;
      onClick({ target, preventDefault: () => (prevented = true), stopPropagation: () => (stopped = true) });
      return { stopped: prevented && stopped, untouched: !prevented && !stopped };
    },
    ask(message) {
      let answered = false, reply;
      const kept = onMessage(message, {}, (r) => ((answered = true), (reply = r)));
      return { answered, reply, kept };
    },
  };
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const rounds = (sent) => [...new Set(sent.map((s) => s.t))];

(async () => {
  // 1. Model keeps failing: rounds at 0, 10, 30, 70 s, nothing in between; quiet after it recovers.
  {
    const posts = Array.from({ length: 3 }, () => post());
    let works = false;
    const p = page(posts, { hideAI: true }, () => works);
    await p.start(); await p.run(80);
    const r = rounds(p.sent);
    check("retry rounds at 0/10/30/70 s while the model fails", JSON.stringify(r) === "[0,10,30,70]", `rounds: ${JSON.stringify(r)}`);
    const observedBefore = posts[0].observed;
    await p.run(5); // 81..85 s, inside the 80 s wait that ends at 150 s
    check("errored posts aren't re-observed during the wait", posts[0].observed === observedBefore, `observed ${posts[0].observed - observedBefore} more times`);
    works = true; await p.run(155); // next round is at 150 s
    const states = posts.map((x) => x.dataset.ai).join(",");
    check("after recovery every post gets a verdict", states === "no,no,no", `states: ${states}`);
    const before = p.sent.length; await p.run(700);
    check("quiet after recovery (no more messages)", p.sent.length === before, `${p.sent.length - before} extra messages`);
    // A new failure after recovery starts over at a 10 s wait, not where the old one left off.
    works = false;
    const fresh = post(); posts.push(fresh);
    await p.run(1);
    const failedAt = p.sent[p.sent.length - 1].t;
    posts.push(post());
    await p.run(25);
    const next = p.sent.filter((x) => x.t > failedAt).map((x) => x.t)[0];
    check("after recovery, the next failure waits 10 s again", next - failedAt === 10, `next round ${next - failedAt} s after the failure`);
  }

  // 2. During the wait: a styled post is flagged at once; a post that needs the model waits without a message.
  {
    const posts = [post()];
    const p = page(posts, { hideAI: true }, () => false);
    await p.start(); await p.run(3); // first failure at 0 s, wait until 10 s
    const styledPost = post({ text: styled }), modelPost = post();
    posts.push(styledPost, modelPost);
    const before = p.sent.length; await p.run(2);
    check("style flag doesn't wait for the model", styledPost.dataset.ai === "yes" && !!styledPost.dataset.aiStyle, `data-ai=${styledPost.dataset.ai}`);
    check("model post during the wait: parked, no message", p.sent.length === before && modelPost.dataset.ai === "error", `messages +${p.sent.length - before}, data-ai=${modelPost.dataset.ai}`);
    await p.run(6);
    check("parked post is sent at the next round (10 s)", p.sent.filter((s) => s.t === 10).length === 2, `round 10 s: ${p.sent.filter((s) => s.t === 10).length} messages (expected 2)`);
  }

  // 3. Hide ads only: ordinary posts are walked once, the ad is found.
  {
    const ordinary = Array.from({ length: 5 }, () => post());
    const ad = post({ labels: ["Made Up Name", "Promoted"] });
    const p = page([...ordinary, ad], { hideAds: true }, () => true);
    await p.start(); await p.run(30);
    const walks = ordinary.map((x) => x.walks).join(",");
    check("ordinary posts walked once in 30 s", ordinary.every((x) => x.walks === 1) && ordinary.every((x) => x.dataset.ad === "no"), `walks: ${walks}`);
    check("the ad is marked", ad.dataset.ad === "yes", `data-ad=${ad.dataset.ad}`);
  }

  // 4. A post that is empty at first and fills in with a Promoted label is still caught.
  {
    const late = post({ text: "", labels: [] });
    const p = page([post(), late], { hideAds: true }, () => true);
    await p.start(); await p.run(3);
    late.els = ["Made Up Name", "Promoted"].map(leaf); late.text = long;
    await p.run(2);
    check("late-filled ad is caught", late.dataset.ad === "yes", `data-ad=${late.dataset.ad}`);
  }

  // 5. Both switches on: a hidden ad is not observed and not sent; one that fills in just before
  //    the observer fires isn't sent either. 6. With Hide ads off, ads are checked like any post.
  {
    const ad = post({ labels: ["Made Up Name", "Promoted"] });
    const lateAd = post({ text: "", labels: [], onScreen: false });
    const settings = { hideAI: true, hideAds: true };
    const p = page([post(), ad, lateAd], settings, () => true);
    await p.start(); await p.run(2);
    check("hidden ad isn't observed for AI", !p.watching.has(ad), `observed: ${p.watching.has(ad)}`);
    // The empty post is being watched. It fills in as an ad and scrolls into view before the next tick.
    check("empty post is observed while waiting to fill in", p.watching.has(lateAd), `observed: ${p.watching.has(lateAd)}`);
    lateAd.els = ["Made Up Name", "Promoted"].map(leaf); lateAd.text = long;
    const before = p.sent.length;
    await p.scrollIn(lateAd);
    check("late-filled ad never reaches the model", p.sent.length === before && !lateAd.dataset.ai, `messages +${p.sent.length - before}, data-ai=${lateAd.dataset.ai}`);
    check("no ad text ever sent while both switches are on", !ad.dataset.ai, `ad data-ai=${ad.dataset.ai}`);
    await p.change({ hideAds: false });
    await p.run(2);
    check("with Hide ads off, the ad is checked by the model", ad.dataset.ai === "no", `ad data-ai=${ad.dataset.ai}`);
  }

  // 7. The middle band: a 0.7 text score flags a post with 2 style points, not one with 1 point;
  //    with an image, the text score decides, never the image's; the model flags alone at 0.9+;
  //    3+ points skip the model. Replies are built like detect() in detect.js.
  {
    const twoPoints = long + "\nIs it worth it — really?"; // em dash + closing question
    const media = "https://media.licdn.com/dms/image/v2/x/feedshare-shrink_800/0/1";
    const band = post({ text: twoPoints });
    const onePoint = post({ text: long + "\nIs it worth it?" });
    const imageHigh = post({ text: long + "\nIs it worth it — truly?", images: [media] }); // text 0.3, image 0.7
    const textBand = post({ text: long + "\nIs it worth it — honestly?", images: [media] }); // text 0.6, image 0.8
    const sure = post({ text: long + " sure" });
    const styledPost = post({ text: styled });
    const scores = { [imageHigh.text]: [0.3, 0.7], [textBand.text]: [0.6, 0.8], [sure.text]: [0.95] };
    const p = page([band, onePoint, imageHigh, textBand, sure, styledPost], { hideAI: true }, (now, m) => {
      const [text, image] = scores[m.text] ?? [0.7];
      const score = Math.max(text, ...(m.images.length ? [image] : []));
      return { score, isAI: score >= 0.9, textScore: text };
    });
    await p.start(); await p.run(2);
    const d = band.dataset;
    check("band: 0.7 + 2 style points flags, bar shows percent and signals",
      d.ai === "yes" && String(d.aiPercent) === "70" && d.aiBand === "em dash, closing question" && !d.aiStyle,
      `data-ai=${d.ai}, percent=${d.aiPercent}, band=${d.aiBand}, style=${d.aiStyle}`);
    check("band: 0.7 + 1 style point isn't flagged", onePoint.dataset.ai === "no" && !onePoint.dataset.aiBand, `data-ai=${onePoint.dataset.ai}`);
    const sentImage = (t) => p.sent.some((x) => x.m.text === t.text && x.m.images.length === 1);
    check("band: an image score alone doesn't trigger it (text 0.3, image 0.7)",
      sentImage(imageHigh) && imageHigh.dataset.ai === "no" && !imageHigh.dataset.aiBand,
      `sent with image: ${sentImage(imageHigh)}, data-ai=${imageHigh.dataset.ai}`);
    check("band: a text score in the band flags a post with an image; bar shows the highest score (text 0.6, image 0.8)",
      sentImage(textBand) && textBand.dataset.ai === "yes" && textBand.dataset.aiBand === "em dash, closing question" && String(textBand.dataset.aiPercent) === "80",
      `sent with image: ${sentImage(textBand)}, data-ai=${textBand.dataset.ai}, band=${textBand.dataset.aiBand}, percent=${textBand.dataset.aiPercent}`);
    check("model sure on its own (isAI) flags without band signals", sure.dataset.ai === "yes" && !sure.dataset.aiBand && !sure.dataset.aiStyle,
      `data-ai=${sure.dataset.ai}, band=${sure.dataset.aiBand}`);
    check("3+ style points still skip the model", styledPost.dataset.ai === "yes" && !!styledPost.dataset.aiStyle && !p.sent.some((x) => x.m.text === styled),
      `data-ai=${styledPost.dataset.ai}, sent=${p.sent.some((x) => x.m.text === styled)}`);
  }

  // 8. The popup's { type: "counts" } message: content.js answers at once with countPosts() of
  //    the posts on the page now, marked by content.js itself, and whether Show all is on (off
  //    here); other messages get no answer.
  {
    const styledPost = post({ text: styled });
    const sure = post({ text: long + " sure" });
    const band = post({ text: long + "\nIs it worth it — really?" }); // em dash + closing question
    const human = post();
    const ad = post({ labels: ["Made Up Name", "Promoted"] });
    const failing = post({ text: long + " broken" });
    const slow = post({ text: long + " slow" });
    const offScreen = post({ onScreen: false });
    const posts = [styledPost, sure, band, human, ad, failing, slow, offScreen];
    const p = page(posts, { hideAI: true, hideAds: true }, (now, m) => {
      if (m.text === sure.text) return { score: 0.95, isAI: true, textScore: 0.95 };
      if (m.text === band.text) return { score: 0.7, isAI: false, textScore: 0.7 };
      if (m.text === failing.text) return false;
      if (m.text === slow.text) return new Promise(() => {}); // never answers: stays "checking"
      return true;
    });
    await p.start(); await p.run(2);
    const expected = { posts: 8, checked: 4, checking: 1, failed: 1, model: 1, style: 1, band: 1, revealed: 0, ads: 1, showAll: false };
    let a = p.ask({ type: "counts" });
    check("counts: answered at once with what content.js marked on the page",
      a.answered && a.kept !== true && JSON.stringify(a.reply) === JSON.stringify(expected),
      `answered=${a.answered}, kept=${a.kept}, reply=${JSON.stringify(a.reply)}`);
    sure.dataset.revealed = "yes"; // what clicking its bar does
    posts.splice(posts.indexOf(human), 1); // LinkedIn took a post off the page
    a = p.ask({ type: "counts" });
    const after = { ...expected, posts: 7, checked: 3, revealed: 1 };
    check("counts: a revealed post keeps its reason; only posts on the page now count",
      JSON.stringify(a.reply) === JSON.stringify(after), `reply=${JSON.stringify(a.reply)}`);
    const other = [p.ask({ type: "detect" }), p.ask(undefined)];
    check("counts: other messages get no answer", other.every((x) => !x.answered && x.kept !== true),
      other.map((x) => `answered=${x.answered}`).join(", "));
  }

  // 9. Clicking the bar: a collapsed post opens, its thin bar on top collapses it again, and the
  //    counts follow. Clicks inside the post (links, like, comment) are left to LinkedIn.
  {
    const flagged = post({ text: styled });
    const human = post();
    const p = page([flagged, human], { hideAI: true }, () => true);
    await p.start(); await p.run(2);
    const revealed = () => p.ask({ type: "counts" }).reply.revealed;
    let c = p.click(flagged);
    check("click: the collapsed bar opens the post, and LinkedIn doesn't see the click",
      c.stopped && flagged.dataset.revealed === "yes" && revealed() === 1, `stopped=${c.stopped}, revealed=${flagged.dataset.revealed}, count=${revealed()}`);
    const inside = [p.click(flagged.child), p.click(human.child), p.click(human)];
    check("click: inside an open post, or on a post that isn't flagged, is LinkedIn's as usual",
      inside.every((x) => x.untouched) && flagged.dataset.revealed === "yes" && !human.dataset.revealed,
      `untouched=${inside.map((x) => x.untouched)}, revealed=${flagged.dataset.revealed}`);
    c = p.click(flagged);
    check("click: the bar on an open post collapses it again, and the count goes back down",
      c.stopped && !("revealed" in flagged.dataset) && revealed() === 0, `stopped=${c.stopped}, revealed=${flagged.dataset.revealed}, count=${revealed()}`);
    p.click(flagged); // open again, then Hide AI posts goes off: nothing is collapsed, no bar to click
    await p.change({ hideAI: false });
    c = p.click(flagged);
    check("click: with Hide AI posts off, clicks on flagged posts are LinkedIn's", c.untouched && flagged.dataset.revealed === "yes",
      `untouched=${c.untouched}, revealed=${flagged.dataset.revealed}`);
  }

  // 10. The popup's Show all button: shows every flagged post on this tab, new ones come in
  //     shown, the same button collapses them all again. Ads stay hidden. Never saved.
  {
    const flagged = post({ text: styled });
    const sure = post({ text: long + " sure" });
    const human = post();
    const ad = post({ text: styled + " ad", labels: ["Made Up Name", "Promoted"] });
    const posts = [flagged, sure, human, ad];
    const isSure = (m) => m.text.endsWith(" sure");
    // showAll planted in storage: content.js must not read it from there either.
    const settings = { hideAI: true, hideAds: false, showAll: true };
    const p = page(posts, settings, (now, m) => (isSure(m) ? { score: 0.95, isAI: true, textScore: 0.95 } : true));
    await p.start(); await p.run(2);
    await p.change({ hideAds: true }); await p.run(1); // the ad was flagged as AI before Hide ads went on
    const start = p.ask({ type: "counts" }).reply;
    check("show all: off when the page loads, whatever is in storage",
      start.showAll === false && start.revealed === 0 && ad.dataset.ad === "yes" && ad.dataset.ai === "yes",
      `showAll=${start.showAll}, revealed=${start.revealed}, ad=${ad.dataset.ad}/${ad.dataset.ai}`);

    p.click(sure); // opened by hand first
    const on = p.ask({ type: "showAll", on: true });
    check("show all: every flagged post opens and the reply says so; others and the ad's mark are untouched",
      on.answered && on.reply.showAll === true && on.reply.revealed === 2 && on.reply.ads === 1 &&
        flagged.dataset.revealed === "yes" && sure.dataset.revealed === "yes" && !human.dataset.revealed && ad.dataset.ad === "yes",
      `reply=${JSON.stringify(on.reply)}, human=${human.dataset.revealed}, ad=${ad.dataset.ad}`);

    // Posts flagged while Show all is on come in shown, by style and by the model, never collapsed first.
    const newStyled = post({ text: styled + " later" }), newSure = post({ text: long + " later sure" });
    const flaggedCollapsed = [];
    for (const x of [newStyled, newSure]) {
      x.dataset = new Proxy({}, { set(d, k, v) { if (k === "ai" && v === "yes" && !d.revealed) flaggedCollapsed.push(x); d[k] = v; return true; } });
    }
    posts.push(newStyled, newSure);
    await p.run(2);
    const counts = p.ask({ type: "counts" }).reply;
    check("show all: posts flagged afterwards (style and model) come in shown, never collapsed first",
      newStyled.dataset.revealed === "yes" && newSure.dataset.revealed === "yes" && flaggedCollapsed.length === 0 &&
        counts.showAll === true && counts.revealed === 4,
      `styled=${newStyled.dataset.revealed}, sure=${newSure.dataset.revealed}, collapsed first=${flaggedCollapsed.length}, counts=${JSON.stringify(counts)}`);

    p.click(flagged); // one collapsed by hand while Show all is on
    await p.change({ hideAds: false }); await p.change({ hideAds: true }); // switch flips reload settings
    const still = p.ask({ type: "counts" }).reply;
    check("show all: a post can still be collapsed by hand, and flipping a switch doesn't end Show all",
      !flagged.dataset.revealed && still.showAll === true && still.revealed === 3, `counts=${JSON.stringify(still)}`);

    const off = p.ask({ type: "showAll", on: false });
    const flaggedPosts = [flagged, sure, newStyled, newSure];
    check("show all off: every flagged post collapses, opened by hand or not; the reply says so",
      off.reply.showAll === false && off.reply.revealed === 0 && flaggedPosts.every((x) => !("revealed" in x.dataset)) && !("revealed" in ad.dataset),
      `reply=${JSON.stringify(off.reply)}`);
    const after = post({ text: styled + " after" });
    posts.push(after);
    await p.run(2);
    check("show all off: posts flagged afterwards collapse as usual", after.dataset.ai === "yes" && !after.dataset.revealed,
      `data-ai=${after.dataset.ai}, revealed=${after.dataset.revealed}`);

    // styles.css: ads are hidden whole whatever data-revealed says; the open post's bar is the only
    // part of the post's own box that takes clicks, and everything inside it takes them as usual.
    const css = fs.readFileSync(path.join(dir, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body }));
    const adRule = rules.find((r) => r.sel.split(",").some((s) => s.trim() === 'html.hide-ads [data-ad="yes"]'));
    const rule = (sel) => rules.find((r) => r.sel === sel)?.body ?? "";
    const open = 'html.hide-ai [data-ai="yes"][data-revealed]';
    check("styles.css: ads hidden whatever data-revealed says; the open post's bar alone takes its clicks",
      !!adRule && /display:\s*none/.test(adRule.body) && !/revealed/.test(adRule.sel) &&
        /pointer-events:\s*none/.test(rule(open)) && /pointer-events:\s*auto/.test(rule(open + ' > :not([data-ai="yes"][data-revealed])')) &&
        /pointer-events:\s*auto/.test(rule(open + "::before")) && /collapse/i.test(rule(open + "::before")),
      `ad rule: ${adRule?.sel}`);
  }

  // 11. Reshares (old layout: the inner post is its own post element inside the outer one). Each
  //     post is checked on its own content: the outer post skips text, images and the Promoted
  //     label inside the inner post, which is checked, counted and hidden on its own.
  {
    const resharer = "Made up note from the resharer about a garden shed, nothing more to it. ".repeat(3).trim(); // 215 chars, trimmed like content.js sends it
    const ownImage = "https://media.licdn.com/dms/image/v2/own/feedshare-shrink_800/0/1";
    const innerImage = "https://media.licdn.com/dms/image/v2/inner/feedshare-shrink_800/0/1";
    // Bars a person can see: flagged posts that aren't inside a collapsed flagged post.
    const bars = (posts) => posts.filter((x) => x.dataset.ai === "yes" && !(x.outer?.dataset.ai === "yes" && !x.outer.dataset.revealed));
    const countsOf = (p) => { const { posts, checked, model, style, ads } = p.ask({ type: "counts" }).reply; return { posts, checked, model, style, ads }; };

    // a. The resharer's own human words, and an AI-style inner post.
    {
      const inner = post({ text: styled });
      const outer = post({ text: resharer, nested: [inner] });
      const p = page([outer, inner], { hideAI: true }, () => true);
      await p.start(); await p.run(2);
      const outerSent = p.sent.filter((x) => x.m.text === resharer);
      const c = countsOf(p);
      p.click(inner);
      check("reshare with human text, AI inner post: only the inner post is flagged, on its own text, counted once",
        outer.dataset.ai === "no" && inner.dataset.ai === "yes" && !!inner.dataset.aiStyle && outerSent.length === 1 &&
          outerSent[0].m.images.length === 0 && c.posts === 2 && c.checked === 2 && c.style === 1 &&
          inner.dataset.revealed === "yes" && !outer.dataset.revealed,
        `outer=${outer.dataset.ai}, inner=${inner.dataset.ai}, outer sent ${outerSent.length}x, counts=${JSON.stringify(c)}, revealed outer/inner=${outer.dataset.revealed}/${inner.dataset.revealed}`);
    }

    // b. A bare reshare (no words of the resharer's) of a post the model flags.
    {
      const inner = post({ text: long + " sure" });
      const outer = post({ text: "", labels: ["Made Up Resharer"], nested: [inner] });
      const p = page([outer, inner], { hideAI: true }, (now, m) => (m.text.endsWith(" sure") ? { score: 0.95, isAI: true, textScore: 0.95 } : true));
      await p.start(); await p.run(2);
      const c = countsOf(p);
      const seen = bars([outer, inner]);
      check("bare reshare of an AI post: sent to the model once, flagged and counted once, one bar (the inner post's)",
        p.sent.length === 1 && outer.dataset.ai === "no" && inner.dataset.ai === "yes" && c.model === 1 && seen.length === 1 && seen[0] === inner,
        `sent ${p.sent.length}x, outer=${outer.dataset.ai}, inner=${inner.dataset.ai}, counts=${JSON.stringify(c)}, bars=${seen.length}`);
    }

    // c. The resharer's own words and image, and an inner post with an image the model flags.
    {
      const inner = post({ text: long, images: [innerImage] });
      const outer = post({ text: resharer, images: [ownImage], nested: [inner] });
      const p = page([outer, inner], { hideAI: true }, (now, m) => {
        const score = Math.max(0.1, ...m.images.map((url) => (url === innerImage ? 0.95 : 0.2)));
        return { score, isAI: score >= 0.9, textScore: 0.1 };
      });
      await p.start(); await p.run(2);
      const outerSent = p.sent.find((x) => x.m.text === resharer);
      const innerSent = p.sent.find((x) => x.m.text === inner.text.trim());
      check("reshare with an image in the inner post: the outer post sends only its own image, isn't flagged by the inner one's",
        JSON.stringify(outerSent?.m.images) === JSON.stringify([ownImage]) && JSON.stringify(innerSent?.m.images) === JSON.stringify([innerImage]) &&
          outer.dataset.ai === "no" && inner.dataset.ai === "yes" && countsOf(p).model === 1,
        `outer sent ${JSON.stringify(outerSent?.m.images)}, inner sent ${JSON.stringify(innerSent?.m.images)}, outer=${outer.dataset.ai}, inner=${inner.dataset.ai}`);
    }

    // d. A reshared Promoted post; and a Promoted post of its own that has a post inside it.
    {
      const innerAd = post({ labels: ["Made Up Brand", "Promoted"] });
      const outer = post({ text: resharer, nested: [innerAd] });
      const plainInner = post();
      const ownAd = post({ labels: ["Made Up Brand", "Promoted"], nested: [plainInner] });
      const p = page([outer, innerAd, ownAd, plainInner], { hideAI: true, hideAds: true }, () => true);
      await p.start(); await p.run(2);
      const c = countsOf(p);
      check("reshared Promoted post: only the inner post is an ad (hidden, not sent); the resharer's post is checked as usual",
        innerAd.dataset.ad === "yes" && outer.dataset.ad === "no" && outer.dataset.ai === "no" && !innerAd.dataset.ai &&
          ownAd.dataset.ad === "yes" && plainInner.dataset.ad === "no" && c.ads === 2,
        `inner ad=${innerAd.dataset.ad}, outer ad=${outer.dataset.ad}/ai=${outer.dataset.ai}, inner ai=${innerAd.dataset.ai}, own ad=${ownAd.dataset.ad}, its inner=${plainInner.dataset.ad}, ads=${c.ads}`);
    }

    // e. styles.css: an open flagged post inside an open flagged post, as its direct child. The rule
    //    letting the outer post's children take clicks mustn't match it, or its padding takes clicks.
    {
      const css = fs.readFileSync(path.join(dir, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const open = 'html.hide-ai [data-ai="yes"][data-revealed]';
      const childRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter(([, sel, body]) => sel.trim().startsWith(open + " > ") && /pointer-events:\s*auto/.test(body))
        .map(([, sel]) => sel.trim().slice(open.length + 3));
      const takesClicks = (dataset) => childRules.some((child) => child === "*" || matches(dataset, child));
      check("styles.css: a nested open flagged post that's a direct child doesn't take clicks on its padding; other children do",
        childRules.length === 1 && !takesClicks({ ai: "yes", revealed: "yes" }) &&
          takesClicks({}) && takesClicks({ ai: "yes" }) && takesClicks({ ai: "no" }),
        `children rule: ${JSON.stringify(childRules)}`);
    }
  }

  // 12. Show all ends when LinkedIn moves to another page without reloading (another path, seen
  //     by the timer within a second): the popup's button says Show all again, and the new page's
  //     posts come in collapsed. A change of just the ?query or #hash isn't another page.
  {
    const a = post({ text: styled }), b = post({ text: long + " sure" }), c = post();
    const posts = [a, b, c];
    const isSure = (m) => m.text.endsWith(" sure");
    const p = page(posts, { hideAI: true }, (now, m) => (isSure(m) ? { score: 0.95, isAI: true, textScore: 0.95 } : true));
    await p.start(); await p.run(2);
    p.ask({ type: "showAll", on: true });
    p.navigate({ search: "?made-up=1", hash: "#comments" });
    await p.run(2);
    let r = p.ask({ type: "counts" }).reply;
    check("page change: a new ?query or #hash on the same page keeps Show all",
      r.showAll === true && a.dataset.revealed === "yes" && b.dataset.revealed === "yes", `reply=${JSON.stringify(r)}`);

    // Another page: LinkedIn swaps in new posts (one old post may linger in the page for a moment).
    const newStyled = post({ text: styled + " new page" }), newSure = post({ text: long + " new page sure" });
    const openedEver = [];
    for (const x of [newStyled, newSure]) {
      x.dataset = new Proxy({}, { set(d, k, v) { if (k === "revealed") openedEver.push(x); d[k] = v; return true; } });
    }
    posts.splice(1, 2, newStyled, newSure); // a stays, b and c are gone
    p.navigate({ pathname: "/in/made-up-person/", search: "", hash: "" });
    await p.run(1);
    r = p.ask({ type: "counts" }).reply;
    check("page change: another path ends Show all within a second; the reply says so (the button says Show all again)",
      r.showAll === false && r.revealed === 0 && !("revealed" in a.dataset), `reply=${JSON.stringify(r)}, old post revealed=${a.dataset.revealed}`);
    await p.run(2);
    check("page change: the new page's flagged posts come in collapsed, never opened first (style and model)",
      newStyled.dataset.ai === "yes" && newSure.dataset.ai === "yes" && openedEver.length === 0 && p.ask({ type: "counts" }).reply.revealed === 0,
      `new posts: ${newStyled.dataset.ai}/${newSure.dataset.ai}, opened at some point: ${openedEver.length}`);

    // With Show all off, moving on leaves a post opened by a click alone; Show all works again after.
    p.click(newStyled);
    p.navigate({ pathname: "/feed/" });
    await p.run(1);
    const clickedStays = newStyled.dataset.revealed === "yes";
    r = p.ask({ type: "showAll", on: true }).reply;
    check("page change: with Show all off nothing is touched; Show all can be turned on again on the new page",
      clickedStays && r.showAll === true && newSure.dataset.revealed === "yes", `clicked post still open=${clickedStays}, reply=${JSON.stringify(r)}`);
  }

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  (" + r.detail + ")"}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

// Checks the content.js wiring that the node --test suite can't reach: the retry wait,
// style flags during the wait, ads walked once, late-filled ads, hidden ads skipping the model,
// and the middle band (aiVerdict in rules.js) before and after the model.
// Runs style.js, rules.js and content.js together with a fake page, clock and chrome API.
// Usage: node verify-wiring.js /workspace/ai-content-toggle
const fs = require("fs"), path = require("path"), vm = require("vm");
const dir = path.resolve(process.argv[2] || ".");
const files = ["style.js", "rules.js", "content.js"].filter((f) => fs.existsSync(path.join(dir, f)));

const long = "plain made up words about garden sheds and weekend plans ".repeat(5); // 290 chars
const styled = "**Key takeaways** from my made up week:\n" + long;
const leaf = (text) => ({ children: [], textContent: text, closest: () => null });

function post({ text = long, labels = ["Made Up Name"], onScreen = true, images = [] } = {}) {
  const p = { dataset: {}, text, els: labels.map(leaf), onScreen, walks: 0 };
  p.querySelectorAll = (sel) => {
    if (sel === "*") return p.walks++, p.els;
    if (sel === "img") return images.map((src) => ({ src }));
    if (sel.includes("expandable") && p.text) return [{ innerText: p.text, closest: () => null }];
    return [];
  };
  Object.defineProperty(p, "textContent", { get: () => [p.text, ...p.els.map((e) => e.textContent)].join(" ").trim() });
  return p;
}

// One fresh page per scenario. model: (now, message) => true (works, score 0.1), false (fails),
// or the reply itself, like { score: 0.7, isAI: false }.
function page(posts, settings, model) {
  let now = 0, tick, onChange;
  const sent = [];
  const watching = new Set();
  let observer;
  const ctx = {
    console: { log() {}, warn() {} },
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval() {},
    document: { querySelectorAll: () => posts, documentElement: { classList: { toggle() {} } }, addEventListener() {} },
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
      } },
      storage: { local: { get: async () => ({ ...settings }) }, onChanged: { addListener: (fn) => (onChange = fn) } },
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
    async change(next) { Object.assign(settings, next); onChange(); await flush(); await flush(); },
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

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  (" + r.detail + ")"}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

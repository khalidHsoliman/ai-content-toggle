// Pins popup.js: the two switches, this tab's counts from content.js, and the Show all button.
// Run with `node --test`.
// popup.js runs against a fake DOM built from popup.html's own markup and a fake chrome API.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dir = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(dir, "popup.js"), "utf8");

// countPosts (rules.js) decides which counts there are; the popup must show every one of them.
const rules = vm.createContext({ STYLE_MIN_POINTS: 3 });
vm.runInContext(fs.readFileSync(path.join(dir, "rules.js"), "utf8"), rules);
const KEYS = Object.keys(vm.runInContext("countPosts([])", rules));

// The elements popup.js uses, read from popup.html's tags: ids, data-count, role and hidden.
function fakeDocument() {
  const elements = [];
  for (const [, tag, attrText] of html.matchAll(/<(\w+)([^>]*)>/g)) {
    const attrs = Object.fromEntries([...attrText.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k, v ?? ""]));
    if (!attrs.id && !attrs["data-count"]) continue;
    const listeners = {};
    let text = "";
    elements.push({
      tag, attrs, id: attrs.id, hidden: "hidden" in attrs, checked: false,
      dataset: attrs["data-count"] ? { count: attrs["data-count"] } : {},
      get textContent() { return text; },
      set textContent(value) { text = String(value); }, // like the DOM: 0 becomes "0"
      addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
      fire(type) { for (const fn of listeners[type] ?? []) fn({ type, target: this }); },
    });
  }
  return {
    elements,
    getElementById: (id) => elements.find((el) => el.id === id) ?? null,
    querySelectorAll(selector) {
      if (selector === 'input[role="switch"]') return elements.filter((el) => el.tag === "input" && el.attrs.role === "switch");
      if (selector === "[data-count]") return elements.filter((el) => el.attrs["data-count"]);
      throw new Error(`fake document doesn't know ${selector}`);
    },
  };
}

// Objects made inside popup.js come from the VM's realm; copy them into this one to compare.
const plain = (value) => JSON.parse(JSON.stringify(value));

// One popup. stored: chrome.storage.local. hold: storage.get waits for popup.release(). answer(tabId, message): what the tab's content.js
// replies, or a rejected promise like Chrome's when no content script is there. tabs: the active tab(s).
function openPopup({ stored = { hideAI: true, hideAds: true }, answer = () => undefined, tabs = [{ id: 7 }], hold = false } = {}) {
  const document = fakeDocument();
  let release;
  const loaded = hold ? new Promise((resolve) => (release = resolve)) : Promise.resolve();
  const calls = { set: [], query: [], sent: [], created: [], intervals: [] };
  const chrome = {
    storage: {
      local: {
        get: async (keys) => (await loaded, Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]]))),
        set: async (items) => (calls.set.push(plain(items)), Object.assign(stored, items)),
      },
    },
    tabs: {
      query: async (info) => (calls.query.push(plain(info)), tabs),
      sendMessage: async (tabId, message) => (calls.sent.push(plain({ tabId, message })), answer(tabId, message)),
      create: async (props) => calls.created.push(plain(props)),
    },
  };
  const setInterval = (fn, ms) => calls.intervals.push({ fn, ms });
  vm.runInNewContext(popupJs, { document, chrome, setInterval }, { filename: "popup.js" });
  const el = (id) => document.getElementById(id);
  const shown = (id) => !el(id).hidden;
  return {
    document, calls, el, shown, stored, release,
    settle: () => new Promise((resolve) => setTimeout(resolve, 5)),
    // What the counts block shows: the numbers by key, or null while the list is hidden.
    numbers: () => (shown("counts") ? Object.fromEntries(document.querySelectorAll("[data-count]").map((dd) => [dd.dataset.count, dd.textContent])) : null),
    async tick() { for (const { fn } of calls.intervals) fn(); await this.settle(); },
  };
}

const page = { posts: 12, checked: 8, checking: 1, failed: 2, model: 1, style: 2, band: 1, revealed: 1, ads: 3 };
const asText = (counts) => Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, String(v)]));
const noConnection = () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));

test("popup.html: a row for every count countPosts returns, and only those", () => {
  const keys = fakeDocument().querySelectorAll("[data-count]").map((dd) => dd.dataset.count);
  assert.deepEqual([...keys].sort(), [...KEYS].sort());
});

test("popup.html: the counts, the no-counts line, both notes and the Show all button start hidden", () => {
  const doc = fakeDocument();
  for (const id of ["counts", "no-counts", "ai-off", "ads-off", "show-all"]) assert.equal(doc.getElementById(id).hidden, true, id);
});

test("switches: loaded from storage, missing ones off", async () => {
  const p = openPopup({ stored: { hideAI: true } });
  await p.settle();
  assert.equal(p.el("hideAI").checked, true);
  assert.equal(p.el("hideAds").checked, false);
});

test("switches: flipping one saves it under its id", async () => {
  const p = openPopup({ stored: {} });
  await p.settle();
  p.el("hideAds").checked = true;
  p.el("hideAds").fire("change");
  assert.deepEqual(p.calls.set, [{ hideAds: true }]);
});

test("compare link: opens the accuracy test page", () => {
  const p = openPopup();
  p.el("compare").fire("click");
  assert.deepEqual(p.calls.created, [{ url: "compare.html" }]);
});

test("a tab that answers: the active tab is asked once the popup opens, and its counts fill the block", async () => {
  const p = openPopup({ answer: () => page });
  await p.settle();
  assert.deepEqual(p.calls.query, [{ active: true, currentWindow: true }]);
  assert.deepEqual(p.calls.sent, [{ tabId: 7, message: { type: "counts" } }]);
  assert.deepEqual(p.numbers(), asText(page));
  assert.equal(p.shown("no-counts"), false);
  // Both switches on: no notes.
  assert.equal(p.shown("ai-off"), false);
  assert.equal(p.shown("ads-off"), false);
});

test("a tab that answers with all zeros shows 0s, not blanks", async () => {
  const zeros = vm.runInContext("countPosts([])", rules);
  const p = openPopup({ answer: () => zeros });
  await p.settle();
  assert.deepEqual(p.numbers(), asText(zeros));
  assert.ok(Object.values(p.numbers()).every((n) => n === "0"));
});

test("a tab that doesn't answer (not LinkedIn, or needs a refresh): one line instead of the counts", async () => {
  const p = openPopup({ answer: noConnection });
  await p.settle();
  assert.equal(p.numbers(), null);
  assert.equal(p.shown("no-counts"), true);
  assert.match(html, /<p id="no-counts"[^>]*>No counts for this tab\. Open LinkedIn, or refresh it if it's already open\.<\/p>/);
});

test("a tab that doesn't answer shows no switch notes, even with both switches off", async () => {
  const p = openPopup({ stored: {}, answer: noConnection });
  await p.settle();
  assert.equal(p.shown("no-counts"), true);
  assert.equal(p.shown("ai-off"), false);
  assert.equal(p.shown("ads-off"), false);
});

test("a reply of nothing, or no active tab at all, counts as no answer", async () => {
  const empty = openPopup({ answer: () => undefined });
  await empty.settle();
  assert.equal(empty.numbers(), null);
  assert.equal(empty.shown("no-counts"), true);

  const none = openPopup({ tabs: [], answer: () => page });
  await none.settle();
  assert.deepEqual(none.calls.sent, []); // nothing to ask
  assert.equal(none.numbers(), null);
  assert.equal(none.shown("no-counts"), true);
});

test("a switch turned off: its note shows under the counts, which are still shown", async () => {
  const aiOff = openPopup({ stored: { hideAI: false, hideAds: true }, answer: () => page });
  await aiOff.settle();
  assert.deepEqual(aiOff.numbers(), asText(page));
  assert.equal(aiOff.shown("ai-off"), true);
  assert.equal(aiOff.shown("ads-off"), false);

  const adsOff = openPopup({ stored: { hideAI: true }, answer: () => page }); // never turned on counts as off
  await adsOff.settle();
  assert.equal(adsOff.shown("ai-off"), false);
  assert.equal(adsOff.shown("ads-off"), true);

  const bothOff = openPopup({ stored: {}, answer: () => page });
  await bothOff.settle();
  assert.equal(bothOff.shown("ai-off"), true);
  assert.equal(bothOff.shown("ads-off"), true);
});

test("turning a switch off in the popup shows its note at once, and on again hides it", async () => {
  const p = openPopup({ answer: () => page });
  await p.settle();
  p.el("hideAI").checked = false;
  p.el("hideAI").fire("change");
  await p.settle(); // no tick needed
  assert.deepEqual(p.calls.set, [{ hideAI: false }]);
  assert.equal(p.shown("ai-off"), true);
  p.el("hideAI").checked = true;
  p.el("hideAI").fire("change");
  await p.settle();
  assert.equal(p.shown("ai-off"), false);
});

test("while open it asks again every second: the counts follow the page", async () => {
  let reply = page;
  const p = openPopup({ answer: () => reply });
  await p.settle();
  assert.deepEqual(p.calls.intervals.map(({ ms }) => ms), [1000]); // one timer, once
  reply = { ...page, checked: 9, checking: 0, model: 2 };
  await p.tick();
  assert.equal(p.calls.sent.length, 2);
  assert.deepEqual(p.numbers(), asText(reply));
});

test("while open, a tab that stops answering switches to the line, and back when it answers", async () => {
  let answer = () => page;
  const p = openPopup({ answer: (...args) => answer(...args) });
  await p.settle();
  answer = noConnection; // e.g. the tab went to another site
  await p.tick();
  assert.equal(p.numbers(), null);
  assert.equal(p.shown("no-counts"), true);
  answer = () => page;
  await p.tick();
  assert.deepEqual(p.numbers(), asText(page));
  assert.equal(p.shown("no-counts"), false);
});

test("the counts wait for the switches to load, so no note flashes on open", async () => {
  const p = openPopup({ answer: () => page, hold: true });
  await p.settle();
  assert.deepEqual(p.calls.sent, []); // storage hasn't answered: nothing asked, no timer yet
  assert.deepEqual(p.calls.intervals, []);
  assert.equal(p.shown("ai-off"), false);
  p.release();
  await p.settle();
  assert.equal(p.calls.sent.length, 1);
  assert.equal(p.el("hideAI").checked, true);
  assert.equal(p.shown("ai-off"), false); // both switches on, so never a note
  assert.deepEqual(p.numbers(), asText(page));
});

// A LinkedIn tab whose content.js keeps Show all like the real one: it opens all 3 flagged posts
// (revealed 3) or collapses them all (revealed 0), and every reply says whether it's on.
function fakeTab({ showAll = false } = {}) {
  const tab = { showAll, revealed: showAll ? 3 : 0 };
  tab.answer = (_id, message) => {
    if (message.type === "showAll") {
      tab.showAll = message.on;
      tab.revealed = message.on ? 3 : 0;
    }
    return { ...page, model: 1, style: 1, band: 1, revealed: tab.revealed, showAll: tab.showAll };
  };
  return tab;
}
const button = (p) => p.el("show-all");

test("show all button: under the counts of a tab that answers, hidden when there are no counts", async () => {
  const p = openPopup({ answer: fakeTab().answer });
  await p.settle();
  assert.equal(p.shown("show-all"), true);
  assert.equal(button(p).disabled, false);
  assert.equal(button(p).textContent, "Show all AI posts on this tab");

  const none = openPopup({ answer: noConnection });
  await none.settle();
  assert.equal(none.shown("show-all"), false);
});

test("show all button: click shows them all on the active tab, and the same button collapses them all again", async () => {
  const tab = fakeTab();
  const p = openPopup({ answer: tab.answer });
  await p.settle();
  button(p).fire("click");
  await p.settle();
  assert.deepEqual(p.calls.sent.at(-1), { tabId: 7, message: { type: "showAll", on: true } });
  assert.equal(tab.showAll, true);
  assert.equal(button(p).textContent, "Collapse all AI posts on this tab");
  assert.equal(p.numbers().revealed, "3"); // the counts follow at once, from the reply

  button(p).fire("click");
  await p.settle();
  assert.deepEqual(p.calls.sent.at(-1), { tabId: 7, message: { type: "showAll", on: false } });
  assert.equal(tab.showAll, false);
  assert.equal(button(p).textContent, "Show all AI posts on this tab");
  assert.equal(p.numbers().revealed, "0");
});

test("show all button: reopening the popup on a tab with Show all on offers to collapse them", async () => {
  const tab = fakeTab({ showAll: true });
  const p = openPopup({ answer: tab.answer });
  await p.settle();
  assert.equal(button(p).textContent, "Collapse all AI posts on this tab");
  button(p).fire("click");
  await p.settle();
  assert.deepEqual(p.calls.sent.at(-1).message, { type: "showAll", on: false });
});

test("show all button: follows the tab each second, e.g. after a refresh or another LinkedIn page turned Show all off", async () => {
  const tab = fakeTab({ showAll: true });
  const p = openPopup({ answer: tab.answer });
  await p.settle();
  Object.assign(tab, { showAll: false, revealed: 0 }); // the tab was refreshed, or moved to another page
  await p.tick();
  assert.equal(button(p).textContent, "Show all AI posts on this tab");
  assert.equal(p.numbers().revealed, "0");
});

test("show all button: nothing goes to storage, only to this tab", async () => {
  const p = openPopup({ answer: fakeTab().answer });
  await p.settle();
  button(p).fire("click");
  await p.settle();
  button(p).fire("click");
  await p.settle();
  assert.deepEqual(p.calls.set, []);
  assert.deepEqual(p.stored, { hideAI: true, hideAds: true });
  assert.ok(p.calls.sent.every(({ tabId }) => tabId === 7));
});

test("show all button: disabled while Hide AI posts is off, and enabled when it's turned on", async () => {
  const p = openPopup({ stored: { hideAds: true }, answer: fakeTab().answer });
  await p.settle();
  assert.equal(p.shown("show-all"), true);
  assert.equal(button(p).disabled, true);
  p.el("hideAI").checked = true;
  p.el("hideAI").fire("change");
  await p.settle();
  assert.equal(button(p).disabled, false);
});

test("show all button: on a tab that stopped answering, the click leaves just the no-counts line", async () => {
  let answer = fakeTab().answer;
  const p = openPopup({ answer: (...args) => answer(...args) });
  await p.settle();
  answer = noConnection;
  button(p).fire("click");
  await p.settle();
  assert.equal(p.shown("no-counts"), true);
  assert.equal(p.shown("show-all"), false);
  assert.equal(p.numbers(), null);
});

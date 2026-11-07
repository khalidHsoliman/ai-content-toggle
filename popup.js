const switches = [...document.querySelectorAll('input[role="switch"]')];
const showAllButton = document.getElementById("show-all");
let showingAll = false; // what this tab said last: its Show all state lives in content.js, not storage

// Each switch is saved under its id (hideAI, hideAds); content.js and the badge react to the change.
for (const box of switches) {
  box.addEventListener("change", () => {
    chrome.storage.local.set({ [box.id]: box.checked });
    showCounts(); // so the switch's note below follows at once
  });
}

// Asks the active tab's content.js, which replies with its counts (countPosts in rules.js) and
// whether Show all is on. No reply means the tab isn't LinkedIn, or it was opened before the
// extension was loaded or reloaded and needs a refresh.
async function ask(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  show(tab && (await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)));
}

function show(counts) {
  document.getElementById("counts").hidden = !counts;
  document.getElementById("no-counts").hidden = !!counts;
  for (const dd of document.querySelectorAll("[data-count]")) dd.textContent = counts?.[dd.dataset.count] ?? "";
  // The counts ignore the switches: a switch that's off leaves its old marks on the page.
  document.getElementById("ai-off").hidden = !counts || document.getElementById("hideAI").checked;
  document.getElementById("ads-off").hidden = !counts || document.getElementById("hideAds").checked;
  showingAll = !!counts?.showAll;
  showAllButton.hidden = !counts;
  // With Hide AI posts off nothing is collapsed, so there's nothing to show.
  showAllButton.disabled = !document.getElementById("hideAI").checked;
  showAllButton.textContent = showingAll ? "Collapse all AI posts on this tab" : "Show all AI posts on this tab";
}

const showCounts = () => ask({ type: "counts" });

// Shows this tab's flagged posts, or collapses them all again. Only this tab, and not saved:
// refreshing the tab, or LinkedIn moving to another page, brings the collapsed bars back.
showAllButton.addEventListener("click", () => ask({ type: "showAll", on: !showingAll }));

// Counts once the switches are loaded, so the notes are right from the start, then every second.
chrome.storage.local.get(switches.map((box) => box.id)).then((settings) => {
  for (const box of switches) box.checked = !!settings[box.id];
  showCounts();
  setInterval(showCounts, 1000);
});

// Opens the accuracy test page in a new tab.
document.getElementById("compare").addEventListener("click", () => chrome.tabs.create({ url: "compare.html" }));

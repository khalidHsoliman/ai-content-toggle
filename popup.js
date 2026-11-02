// Each switch is saved under its id (hideAI, hideAds); content.js and the badge react to the change.
for (const box of document.querySelectorAll('input[role="switch"]')) {
  chrome.storage.local.get(box.id).then((settings) => (box.checked = !!settings[box.id]));
  box.addEventListener("change", () => chrome.storage.local.set({ [box.id]: box.checked }));
}

// Opens the accuracy test page in a new tab.
document.getElementById("compare").addEventListener("click", () => chrome.tabs.create({ url: "compare.html" }));

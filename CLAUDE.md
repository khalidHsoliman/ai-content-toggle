# AI Content Toggle: notes for Claude

Chrome extension (Manifest V3) that hides AI-generated LinkedIn posts, using on-device models through Transformers.js, and LinkedIn ads. Facebook support is planned.

## Working with Khalid

- Prefer the simplest solution. Don't overengineer.
- When his intent is unclear, ask clarifying questions before building.
- Give copy-paste-ready commands and snippets.
- He tests on his real, logged-in LinkedIn, which you can't reach. After each change, tell him exactly what to reload or refresh and what to check.

## Files

- `manifest.json`: version, permissions, content script, popup.
- `background.js`: service worker. Badge, model loading, detection (one at a time), keep-alive during downloads.
- `style.js`: rules for ChatGPT-style LinkedIn formatting (markdown, arrow bullets, em dashes, stock phrases…). Loaded before `content.js` and by the compare page.
- `content.js`: finds posts, flags AI-style posts itself (`data-ai-style`), sends the rest for detection, marks posts with `data-ai` / `data-ad`, handles click-to-show on collapsed posts.
- `styles.css`: collapses AI posts into a "Likely AI post (N%)" or "AI-style post (signals)" bar; hides ads.
- `popup.html` / `popup.js`: two switches stored as `hideAI` and `hideAds` in `chrome.storage.local`, plus a link to the test page.
- `compare.html` / `compare.js`: accuracy test page. Scores labeled posts with the current model, the style rules and, optionally, the large model.
- `lib/`: vendored Transformers.js 4.3.1 and ONNX Runtime Web 1.31.0-dev.20260914 (asyncify WASM) with their licenses. Don't edit these files.

## Models

- Text: `MedAliFarhat/ai-text-detector-onnx` (RoBERTa, q8, English only). Labels: 0 = Human, 1 = AI. Truncate at 512 tokens. It was trained on single-line text, so `textScore` applies NFKC and collapses whitespace first; without that it missed most AI posts on LinkedIn.
- Image: `buildborderless/CommunityForensics-DeepfakeDet-ViT`, the corrected July 2026 release. Older copies, including the onnx-community export, have wrong weights. Preprocessing: shortest edge 440, center crop 384. One logit, so apply a sigmoid.
- Candidate large text model (compare page only): `GabeuxDev/ai-text-detector-v1.01-onnx` (DeBERTa-v3-large, about 1.7 GB fp32, WebGPU only, max 768 tokens).
- `THRESHOLD` in `background.js` is 0.9. `STYLE_MIN_POINTS` in `style.js` is 3.
- A post is flagged if the model score is at least `THRESHOLD` or the style points reach `STYLE_MIN_POINTS`. Style-flagged posts skip the models.

## LinkedIn markup (October 2026)

- Post: `div[role="listitem"][componentkey^="update-card"]`. Old layout: `[data-urn*="urn:li:activity"]`.
- Post text: `[data-testid="expandable-text-box"]`, skipping any inside `[componentkey*="urn:li:comment"]`.
- Promoted label: a leaf element whose text is "Promoted" (English UI).
- Sidebar ad: `iframe[title="advertisement"]`.
- Premium upsells: `a[href*="/premium/products"]`, `a[href*="/premium/referrals"]`.
- Class names are hashed, so don't rely on them. When selectors break, give Khalid a console snippet to discover the new markup instead of guessing.

## Gotchas

- MV3 blocks remote code, so the library and WASM are bundled and `wasmPaths` is set explicitly.
- After the extension is reloaded, already-open LinkedIn tabs need a refresh. The old content script stops quietly.
- `chrome-extension://invalid` errors in LinkedIn's console come from LinkedIn probing for extensions. Ignore them.
- GitHub push protection flags a gist ID in `lib/transformers.min.js` as a Mistral API key. It's a false positive.
- Keep the git tag, the release title and the manifest version in sync.

## Status and next steps

- Benchmark (November 2026, v1.2): on 226 human LinkedIn posts from before ChatGPT (one influencer-style author), 9% are flagged (model 6%, style 4%). About half of 80 Claude-written LinkedIn posts are caught. The large model caught 61% vs 46% at the same false-flag rate. On 9 real posts from Khalid's feed the models caught none of the AI posts and style caught 3 of 5. Unicode bold and closing questions are common in pre-ChatGPT human posts, so they weigh little.
- Now: Khalid collects 20+ AI and 20+ human posts from his feed to tune the style weights and `THRESHOLD`. Also check whether the extension reads the full post text or only the part before "…more".
- Later: Facebook support, then the Chrome Web Store (icons, privacy policy, permission justifications).

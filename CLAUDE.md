# AI Content Toggle: notes for Claude

Chrome extension (Manifest V3) that hides AI-generated LinkedIn posts, using on-device models through Transformers.js, and LinkedIn ads. Facebook support is planned.

## Working with Khalid

- Prefer the simplest solution. Don't overengineer.
- When his intent is unclear, ask clarifying questions before building.
- Give copy-paste-ready commands and snippets.
- He tests on his real, logged-in LinkedIn, which you can't reach. After each change, tell him exactly what to reload or refresh and what to check.

## Files

- `manifest.json`: version, permissions, content script, popup.
- `background.js`: service worker. Badge (reacts only to `hideAI`/`hideAds` changes), model loading, image fetch (a dead link is skipped; offline, the post fails and is retried), the shared wait checked before any model runs, detection one at a time, keep-alive during downloads. Model names, dtype and preprocessing live here.
- `detect.js`: `detect()` and `THRESHOLD`, with the scorers passed in so node can test them. Replies `{ score, isAI, textScore }`: `score` is the highest of the text and image scores, `isAI` is `score >= THRESHOLD`, `textScore` is the text model's alone (null when no text was sent). A rejected score fails the post (background.js replies null, content.js retries); a null image score (dead link) is skipped.
- `wait.js`: the retry wait after a model fails, one per model ("text", "image"), 10 s doubling to 10 min, kept in `chrome.storage.session` so all tabs share it and it survives worker restarts. Flipping `hideAI`/`hideAds` resets it. Each tab also has its own wait (`retry` in `rules.js`).
- `style.js`: rules for ChatGPT-style LinkedIn formatting (markdown, arrow bullets, em dashes, stock phrases…). Loaded before `content.js` and by the compare page.
- `rules.js`: content.js's decisions without DOM access: what needs an AI or ad check, the AI verdict (`aiVerdict`, including the middle band), the popup's counts (`countPosts`), the ad verdict, the retry wait after failed checks (10 s doubling to 10 min), the Promoted label, which text and media to send. Loaded after `style.js`, before `content.js`.
- `content.js`: finds posts, flags AI-style posts itself (`data-ai-style`), sends the rest for detection, marks posts with `data-ai` / `data-ad`. Clicking a collapsed post's bar opens it, and the thin bar on top of an open one collapses it again (`data-revealed`). Answers the popup's `counts` and `showAll` messages. Show all is in memory only, for this tab and page: it ends when the page path changes (LinkedIn changes pages without reloading; a new ?query or #hash doesn't count). Each post is checked on its own content: in a reshare (old layout) the outer post skips the reshared post inside it (`el.closest(POST) === post`), which is checked, counted and hidden by itself.
- `styles.css`: collapses AI posts into a "Likely AI post (N%)", "Likely AI post (N%, signals)" (middle band) or "AI-style post (signals)" bar; an open one gets a thin "Flagged as AI · Click to collapse" bar, and only that bar and the post's children take clicks; hides ads.
- `popup.html` / `popup.js`: two switches stored as `hideAI` and `hideAds` in `chrome.storage.local`; the active tab's counts, asked every second while open, with a note when a switch is off and a "No counts for this tab" line when the tab doesn't answer; the Show all button (sent to the tab, never stored); a link to the test page.
- `compare.html` / `compare.js`: accuracy test page. Scores labeled posts with the current model, the style rules, both together as the extension decides, and optionally the large model. Also counts the posts the extension would skip.
- `parse.js`: reads the labeled-post format (`AI`/`Human` line, posts separated by `===`). Used by the compare page and `scripts/score.js`.
- `scripts/score.js`: scores a labeled-post file with the style rules, without a browser or models (`node scripts/score.js posts.txt`). `scripts/sample-posts.txt` has made-up examples.
- `test/`: `node --test` suites for `rules.js`, `style.js`, `parse.js`, `scripts/score.js`, `detect.js`, `wait.js`, `background.js` and the popup (148 tests, no dependencies). `verify-scripts.test.js` also runs `verify-wiring.js`, `verify-band.js` and `verify-worker.js`, so `node --test` takes about 15 s. `background.test.mjs` loads the real `background.js` next to a stand-in `lib/` in a temp folder. Needs Node 20.19+ (22.7+ on Node 22). All fixtures are made up.
- `verify-wiring.js`: runs `style.js`, `rules.js` and `content.js` together on a fake page, clock and chrome API (`node verify-wiring.js`, 45 checks).
- `verify-band.js`: end-to-end check of the style-rule fixes and the middle band (`node verify-band.js`, 31 checks).
- `verify-worker.js`: end-to-end check of the service worker: the real `content.js` in fake tabs against the real `background.js` with a fake `lib/` (`node verify-worker.js`, 10 checks).
- `verify-popup.js`: end-to-end check of the popup: the real `popup.js` on a fake DOM built from `popup.html`, talking to the real `content.js` on a fake page (`node verify-popup.js`, 15 checks). Not run by `node --test`.
- Keep the `verify-*.js` scripts out of `test/`, or `node --test` picks them up directly.
- `lib/`: vendored Transformers.js 4.3.1 and ONNX Runtime Web 1.31.0-dev.20260914 (asyncify WASM) with their licenses. Don't edit these files.

## Models

- Text: `MedAliFarhat/ai-text-detector-onnx` (RoBERTa, q8, English only). Labels: 0 = Human, 1 = AI. Truncate at 512 tokens. It was trained on single-line text, so `textScore` applies NFKC and collapses whitespace first; without that it missed most AI posts on LinkedIn.
- Image: `buildborderless/CommunityForensics-DeepfakeDet-ViT`, the corrected July 2026 release. Older copies, including the onnx-community export, have wrong weights. Preprocessing: shortest edge 440, center crop 384. One logit, so apply a sigmoid.
- Candidate large text model (compare page only): `GabeuxDev/ai-text-detector-v1.01-onnx` (DeBERTa-v3-large, about 1.7 GB fp32, WebGPU only, max 768 tokens).
- `THRESHOLD` in `detect.js` is 0.9. `STYLE_MIN_POINTS` in `style.js` is 3.
- A post is flagged if the style points reach `STYLE_MIN_POINTS` (then the models are skipped), if the model score is at least `THRESHOLD`, or by the middle band: a text score (`textScore`) of at least `BAND_MIN_SCORE` (0.5) with at least `BAND_MIN_POINTS` (2) style points. The band applies to every post, with or without images, and an image score never triggers it; no text score means no band. The band bar still shows the highest score. `aiVerdict` in `rules.js` decides all three.
- Style weights: markdown 3, arrow bullets 2, stock phrases 2, em dash 1, Unicode bold 1, short lines 1, closing question 1, numbered list 1. Plain • dots, ▪ ▫ squares and © ® ™ don't count as bullets. "Thoughts?"/"Agree?" count only at the start of a line, or as "your thoughts?".

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
- Before committing, run `node --test` (which also runs `verify-wiring.js`, `verify-band.js` and `verify-worker.js`) and `node verify-popup.js`.
- Releases: `gh` is logged in. Build `ai-content-toggle.zip` with `git -c core.autocrlf=false archive --prefix=ai-content-toggle/` from the release commit, leaving out `CLAUDE.md`, `test/`, `scripts/`, the `verify-*.js` scripts and `.gitignore` (keep `parse.js`, `detect.js` and `wait.js`: the extension loads them). Without `core.autocrlf=false`, git on this machine (autocrlf is true) writes CRLF line endings into the zip; the v1.2 and v1.3 zips have them, which Chrome doesn't mind. Release notes follow the format of earlier releases (What's changed, Install, Updating from the previous version).

## Status and next steps

- Benchmark (November 2026, v1.2, before the style retune and the middle band): on 226 human LinkedIn posts from before ChatGPT (one influencer-style author), 9% are flagged (model 6%, style 4%). About half of 80 Claude-written LinkedIn posts are caught. The large model caught 61% vs 46% at the same false-flag rate. On 9 real posts from Khalid's feed the models caught none of the AI posts and style caught 3 of 5. Unicode bold and closing questions are common in pre-ChatGPT human posts, so they weigh little.
- Now: Khalid collects 20+ AI and 20+ human posts from his feed to tune the style weights and `THRESHOLD`. Also check whether the extension reads the full post text or only the part before "…more".
- Later: Facebook support, then the Chrome Web Store (icons, privacy policy, permission justifications).

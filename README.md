# AI Content Toggle

A Chrome extension that hides LinkedIn posts likely to be AI-generated, and LinkedIn's ads. AI detection runs entirely in your browser with small open models, so your feed is never sent to a server.

## What it checks

- **Text posts:** posts of 200+ characters written mostly in Latin letters. Posts mostly in other scripts (Arabic, etc.) are skipped, since the model only knows English.
- **Images:** pictures attached to posts. Avatars and company logos are ignored.
- **Videos:** only the cover frame, which is a weak signal.
- **Audio:** not supported yet.
- **Reshares:** when LinkedIn marks the reshared post as a post of its own (the older layout does), the resharer's own words and images are checked apart from it, and the reshared post is checked, counted and hidden by itself. A reshared Promoted post hides just the reshared post.

The ads switch hides, without any AI:

- Posts labeled **Promoted**
- Ads in the right sidebar
- "Try Premium" and "Share Premium" upsells

The **Promoted** label is matched in English, so Promoted posts are only caught when LinkedIn is set to English. Sidebar ads and Premium upsells are caught in any language.

## Install

1. Download `ai-content-toggle.zip` from the [latest release](../../releases/latest) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped `ai-content-toggle` folder.
4. Pin the extension to your toolbar.

To update, download the new release, replace the folder, and click the reload icon on the extension's card.

## Use

Click the extension icon to open its two switches, **Hide AI posts** and **Hide ads**. They work independently, and the badge shows **ON** while either one is on.

A post flagged as AI collapses into a one-line bar. Click the bar to see the post, and the thin "Click to collapse" bar on top of it to collapse it again. Posts are flagged in three ways:

- **By the AI detector:** "Likely AI post (93%) · Click to show", with the model's confidence.
- **By its formatting:** "AI-style post (markdown, arrow bullets) · Click to show", for posts with the telltale signs of ChatGPT-style LinkedIn writing: markdown that LinkedIn doesn't render, arrow and emoji bullets, em dashes, stock phrases like "Here's what changed". These signals are listed in `style.js`.
- **By both together:** "Likely AI post (72%, em dash, closing question) · Click to show", for a post whose text the detector finds somewhat likely (50% or more) that also has some of those signals (2 points' worth, where 3 would flag it alone). Only the text score counts here, so an image alone never flags a post this way. The percent on the bar is the highest of the post's text and image scores.

Ads are hidden completely.

Under the switches, the popup shows what the extension did on the LinkedIn tab you're on, updated every second: how many posts are on the page, how many were checked, are still being checked or failed, how many were hidden by the detector, the formatting rules or both together (and how many of those are open, clicked or by Show all), and how many Promoted posts were hidden. It counts the posts on the page right now. Below the counts, **Show all AI posts on this tab** opens every flagged post on that tab, including ones flagged while you scroll, and the same button collapses them all again. It only affects that tab and the page you turned it on for, and isn't saved: refreshing the tab or moving to another LinkedIn page collapses them again, and the button says Show all again. Ads stay hidden either way. The counts come from marks left on the posts, so if a switch is off, the popup says so: its counts are from before, and those posts are shown. On any other tab, or a LinkedIn tab opened before the extension was installed or reloaded, it says to open LinkedIn or refresh the tab.

The first time it runs, it downloads two models from Hugging Face (about 210 MB in total), so the first posts take a while to check. After that, the models are cached in the browser. If a model download fails, the extension waits before trying again (10 seconds, doubling up to 10 minutes while it keeps failing); flip either switch off and on to retry right away. The wait is shared by all your LinkedIn tabs and kept for each model separately, so a failing image model doesn't stop text posts from being checked. A tab whose own image posts keep failing does hold its new posts until its next retry.

## Accuracy

AI detectors are evidence, not proof. Expect some human-written posts to be hidden (especially polished writing, influencer-style formatting or designed graphics) and many AI posts to slip through, especially ones a person has edited. A post is hidden by the detector only when a model is at least 90% confident. Between 50% and that, it takes some ChatGPT-style formatting as well. You can change this with `THRESHOLD` in `detect.js`, the formatting rules with `STYLE_MIN_POINTS` in `style.js`, and the in-between rule with `BAND_MIN_SCORE` and `BAND_MIN_POINTS` in `rules.js`.

In a test on 226 human LinkedIn posts from before ChatGPT existed, about 9% were wrongly flagged (6% by the detector, 4% by the formatting rules). About half of 80 AI-written LinkedIn posts were caught. The test set is small, so treat these numbers as rough. They were measured before the formatting rules were retuned and the in-between rule was added.

Every post the detector checks gets a `data-ai-score` attribute, one flagged by its formatting gets `data-ai-style`, and one flagged by both together gets `data-ai-band`. Right-click a post and choose **Inspect** to see them.

To see how well detection works on your own feed, click **Test accuracy on your own posts** in the popup. Paste posts you're confident about, each labeled AI or Human, and the page shows how many each threshold catches and how many human posts it wrongly flags, for the detector, the formatting rules, and both together as the extension decides. It can also test a much larger detector (about 1.7 GB, needs a GPU) side by side.

To tune the formatting rules without a browser, save posts in the same format to a text file and run `node scripts/score.js posts.txt`. It prints the page's formatting summary, how often each signal fired in AI and human posts, and one line per flagged post with the signals it hit. `scripts/sample-posts.txt` has made-up examples.

## If it stops working

LinkedIn changes its page structure often. If posts stop being checked, update the selectors at the top of `content.js` (`POST` and `POST_TEXT`) to match the current markup. If ads come back, update `PROMOTED` in `rules.js` or the ad rules in `styles.css`.

The rules in `rules.js` and `style.js`, how `detect.js` turns model scores into a verdict, the background worker (with a stand-in for `lib/`), the popup, and the scoring script have tests: run `node --test` in this folder (nothing to install). It also runs `verify-wiring.js`, `verify-band.js` and `verify-worker.js`, which check content.js and the background worker on fake pages and fail the run if any of their checks fails; each can also be run on its own with `node verify-wiring.js` and so on. They need Node 20.19 or later (22.7 or later on Node 22).

## Privacy

Post text and image links stay in your browser. The only network requests the extension makes are the one-time model downloads from Hugging Face and fetching post images from LinkedIn's CDN for analysis.

## Credits and licenses

Models:
- Text: [MedAliFarhat/ai-text-detector-onnx](https://huggingface.co/MedAliFarhat/ai-text-detector-onnx) (Apache-2.0), an ONNX export of [fakespot-ai/roberta-base-ai-text-detection-v1](https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1)
- Images: [buildborderless/CommunityForensics-DeepfakeDet-ViT](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) (MIT), from *Community Forensics* by Jeongsoo Park and Andrew Owens

Bundled libraries in `lib/` (license files included there):
- [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 (Apache-2.0)
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.31.0-dev.20260914 (MIT)

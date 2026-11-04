# AI Content Toggle

A Chrome extension that hides LinkedIn posts likely to be AI-generated, and LinkedIn's ads. AI detection runs entirely in your browser with small open models, so your feed is never sent to a server.

## What it checks

- **Text posts:** posts of 200+ characters written mostly in Latin letters. Posts mostly in other scripts (Arabic, etc.) are skipped, since the model only knows English.
- **Images:** pictures attached to posts. Avatars and company logos are ignored.
- **Videos:** only the cover frame, which is a weak signal.
- **Audio:** not supported yet.

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

A post flagged as AI collapses into a one-line bar. Click the bar to see the post. Posts are flagged in three ways:

- **By the AI detector:** "Likely AI post (93%) · Click to show", with the model's confidence.
- **By its formatting:** "AI-style post (markdown, arrow bullets) · Click to show", for posts with the telltale signs of ChatGPT-style LinkedIn writing: markdown that LinkedIn doesn't render, arrow and emoji bullets, em dashes, stock phrases like "Here's what changed". These signals are listed in `style.js`.
- **By both together:** "Likely AI post (72%, em dash, closing question) · Click to show", for a post the detector finds somewhat likely (50% or more) that also has some of those signals (2 points' worth, where 3 would flag it alone). This only applies to posts without images or videos.

Ads are hidden completely.

The first time it runs, it downloads two models from Hugging Face (about 210 MB in total), so the first posts take a while to check. After that, the models are cached in the browser. If a model download fails, the extension waits before trying again (10 seconds, doubling up to 10 minutes while it keeps failing); flip either switch off and on to retry right away.

## Accuracy

AI detectors are evidence, not proof. Expect some human-written posts to be hidden (especially polished writing, influencer-style formatting or designed graphics) and many AI posts to slip through, especially ones a person has edited. A post is hidden by the detector only when a model is at least 90% confident. Between 50% and that, it takes some ChatGPT-style formatting as well. You can change this with `THRESHOLD` in `background.js`, the formatting rules with `STYLE_MIN_POINTS` in `style.js`, and the in-between rule with `BAND_MIN_SCORE` and `BAND_MIN_POINTS` in `rules.js`.

In a test on 226 human LinkedIn posts from before ChatGPT existed, about 9% were wrongly flagged (6% by the detector, 4% by the formatting rules). About half of 80 AI-written LinkedIn posts were caught. The test set is small, so treat these numbers as rough. They were measured before the formatting rules were retuned and the in-between rule was added.

Every post the detector checks gets a `data-ai-score` attribute, one flagged by its formatting gets `data-ai-style`, and one flagged by both together gets `data-ai-band`. Right-click a post and choose **Inspect** to see them.

To see how well detection works on your own feed, click **Test accuracy on your own posts** in the popup. Paste posts you're confident about, each labeled AI or Human, and the page shows how many each threshold catches and how many human posts it wrongly flags, for the detector, the formatting rules, and both together as the extension decides. It can also test a much larger detector (about 1.7 GB, needs a GPU) side by side.

To tune the formatting rules without a browser, save posts in the same format to a text file and run `node scripts/score.js posts.txt`. It prints the page's formatting summary, how often each signal fired in AI and human posts, and one line per flagged post with the signals it hit. `scripts/sample-posts.txt` has made-up examples.

## If it stops working

LinkedIn changes its page structure often. If posts stop being checked, update the selectors at the top of `content.js` (`POST` and `POST_TEXT`) to match the current markup. If ads come back, update `PROMOTED` in `rules.js` or the ad rules in `styles.css`.

The rules in `rules.js` and `style.js`, and the scoring script, have tests: run `node --test` in this folder (Node 20 or later, nothing to install).

## Privacy

Post text and image links stay in your browser. The only network requests the extension makes are the one-time model downloads from Hugging Face and fetching post images from LinkedIn's CDN for analysis.

## Credits and licenses

Models:
- Text: [MedAliFarhat/ai-text-detector-onnx](https://huggingface.co/MedAliFarhat/ai-text-detector-onnx) (Apache-2.0), an ONNX export of [fakespot-ai/roberta-base-ai-text-detection-v1](https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1)
- Images: [buildborderless/CommunityForensics-DeepfakeDet-ViT](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) (MIT), from *Community Forensics* by Jeongsoo Park and Andrew Owens

Bundled libraries in `lib/` (license files included there):
- [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 (Apache-2.0)
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.31.0-dev.20260914 (MIT)

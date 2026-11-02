# AI Content Toggle

A Chrome extension that hides LinkedIn posts likely to be AI-generated, and LinkedIn's ads. AI detection runs entirely in your browser with small open models, so your feed is never sent to a server.

## What it checks

- **Text posts:** English posts of 200+ characters. Posts mostly in other scripts (Arabic, etc.) are skipped, since the model only knows English.
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

A post flagged as AI collapses into a one-line bar. Click the bar to see the post. Posts are flagged in two ways:

- **By the AI detector:** "Likely AI post (93%) · Click to show", with the model's confidence.
- **By its formatting:** "AI-style post (markdown, arrow bullets) · Click to show", for posts with the telltale signs of ChatGPT-style LinkedIn writing: markdown that LinkedIn doesn't render, arrow and emoji bullets, em dashes, stock phrases like "Here's what changed". These signals are listed in `style.js`.

Ads are hidden completely.

The first time it runs, it downloads two models from Hugging Face (about 210 MB in total), so the first posts take a while to check. After that, the models are cached in the browser.

## Accuracy

AI detectors are evidence, not proof. Expect some human-written posts to be hidden (especially polished writing, influencer-style formatting or designed graphics) and many AI posts to slip through, especially ones a person has edited. A post is hidden by the detector only when a model is at least 90% confident. You can change this with `THRESHOLD` in `background.js`, and the formatting rules with `STYLE_MIN_POINTS` in `style.js`.

In a test on 226 human LinkedIn posts from before ChatGPT existed, about 9% were wrongly flagged (6% by the detector, 4% by the formatting rules). About half of 80 AI-written LinkedIn posts were caught. The test set is small, so treat these numbers as rough.

A post flagged by the detector gets a `data-ai-score` attribute, and one flagged by its formatting gets `data-ai-style`. Right-click a post and choose **Inspect** to see them.

To see how well detection works on your own feed, click **Test accuracy on your own posts** in the popup. Paste posts you're confident about, each labeled AI or Human, and the page shows how many each threshold catches and how many human posts it wrongly flags, for both the detector and the formatting rules. It can also test a much larger detector (about 1.7 GB, needs a GPU) side by side.

## If it stops working

LinkedIn changes its page structure often. If posts stop being checked, update the selectors at the top of `content.js` (`POST` and `POST_TEXT`) to match the current markup. If ads come back, update `PROMOTED` in `rules.js` or the ad rules in `styles.css`.

## Privacy

Post text and image links stay in your browser. The only network requests the extension makes are the one-time model downloads from Hugging Face and fetching post images from LinkedIn's CDN for analysis.

## Credits and licenses

Models:
- Text: [MedAliFarhat/ai-text-detector-onnx](https://huggingface.co/MedAliFarhat/ai-text-detector-onnx) (Apache-2.0), an ONNX export of [fakespot-ai/roberta-base-ai-text-detection-v1](https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1)
- Images: [buildborderless/CommunityForensics-DeepfakeDet-ViT](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) (MIT), from *Community Forensics* by Jeongsoo Park and Andrew Owens

Bundled libraries in `lib/` (license files included there):
- [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 (Apache-2.0)
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.31.0-dev.20260914 (MIT)

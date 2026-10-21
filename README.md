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

The first time it runs, it downloads two models from Hugging Face (about 210 MB in total), so the first posts take a while to check. After that, the models are cached in the browser.

## Accuracy

AI detectors are evidence, not proof. Expect some human-written posts to be hidden (especially polished writing or designed graphics) and some AI posts to slip through. A post is hidden only when a model is at least 90% confident. You can change this with `THRESHOLD` in `background.js`.

Every checked post gets a `data-ai-score` attribute. Right-click a post and choose **Inspect** to see it.

## If it stops working

LinkedIn changes its page structure often. If posts stop being checked, update the selectors at the top of `content.js` (`POST` and `POST_TEXT`) to match the current markup. If ads come back, update `PROMOTED` in `content.js` or the ad rules in `styles.css`.

## Privacy

Post text and image links stay in your browser. The only network requests the extension makes are the one-time model downloads from Hugging Face and fetching post images from LinkedIn's CDN for analysis.

## Credits and licenses

Models:
- Text: [MedAliFarhat/ai-text-detector-onnx](https://huggingface.co/MedAliFarhat/ai-text-detector-onnx) (Apache-2.0), an ONNX export of [fakespot-ai/roberta-base-ai-text-detection-v1](https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1)
- Images: [buildborderless/CommunityForensics-DeepfakeDet-ViT](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) (MIT), from *Community Forensics* by Jeongsoo Park and Andrew Owens

Bundled libraries in `lib/` (license files included there):
- [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 (Apache-2.0)
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.31.0-dev.20260914 (MIT)

# Publishing Checklist

## Store Copy

- `readme.txt` is present for the Homey Store.
- Store readme is plain text only.
- Store readme has no Markdown, URLs, headings, or changelog content.
- Store readme states that the app is unofficial and not affiliated with Bose.

## Asset Audit

App images referenced by `.homeycompose/app.json`:

- `assets/images/small.png`: 250 x 175
- `assets/images/large.png`: 500 x 350
- `assets/images/xlarge.png`: 1000 x 700

Driver images referenced by `drivers/soundtouch/driver.compose.json`:

- `drivers/soundtouch/assets/images/small.png`: 75 x 75
- `drivers/soundtouch/assets/images/large.png`: 500 x 500
- `drivers/soundtouch/assets/images/xlarge.png`: 1000 x 1000

Icons:

- `assets/icon.svg`: transparent SVG, 960 x 960 viewBox.
- `drivers/soundtouch/assets/icon.svg`: transparent SVG, 960 x 960 viewBox.
- Capability icons are SVG and use `currentColor`.

## Beta Checks

- Publish a Draft with `npx homey app publish`.
- Release a Test version from Homey Developer Tools.
- Install through the Test link on both Homeys.
- Verify the app icon in App Settings.
- Verify the brand and driver icons in Add Device.
- Pair the office and home SoundTouch speakers.
- Verify preset sync, physical preset presses, dashboard controls, and App Settings.

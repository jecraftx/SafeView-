# SafeView Browser Extension

Real-time flash and strobe protection for people with photosensitivity — works automatically on YouTube, TikTok, Instagram, Netflix, Twitch, X, Reddit, Facebook, and Vimeo.

---

## How to Install (Chrome / Edge / Brave)

1. Download and unzip `safeview-extension.zip`
2. Open your browser and go to: `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the unzipped `safeview-extension` folder
6. SafeView is now active — click the extension icon to configure it

---

## How It Works

SafeView injects a lightweight content script into supported video sites. It:

1. **Samples video frames** at ~20fps using an offscreen canvas
2. **Measures luminance changes** between frames using the ITU-R BT.709 relative luminance formula
3. **Counts flash events** — if 3+ significant brightness changes occur per second (W3C guideline threshold), a protection response is triggered
4. **Responds automatically** based on your chosen mode — no user action needed

---

## Protection Modes

| Mode | What it does |
|------|-------------|
| **Auto-dim** | Overlays a dark screen over the page instantly, reducing brightness by 30–90% (configurable) |
| **Flash suppression** | Applies a CSS filter to the video element itself — desaturates and dims the harmful frames while preserving content |
| **Warning alerts** | Shows a non-intrusive banner alerting you to the flash event so you can look away or skip |

---

## Sensitivity Settings

- **Low** — only catches severe, rapid strobing
- **Medium** (default) — balanced, catches most harmful content
- **High** — catches even subtle brightness changes

---

## Supported Sites

- YouTube
- TikTok
- Instagram
- Netflix
- Twitch
- X / Twitter
- Reddit
- Facebook
- Vimeo

---

## Files

```
safeview-extension/
├── manifest.json     — Extension config & permissions
├── background.js     — Service worker (badge, install handler)
├── content.js        — Core engine: frame analysis & protection
├── popup.html        — Extension popup UI
├── popup.js          — Popup logic & settings management
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Technical Notes

- Uses **Manifest V3** (required for Chrome as of 2024)
- Frame sampling is done on a **64×36 offscreen canvas** — low CPU footprint
- Flash detection follows the **W3C WCAG 2.3 guideline**: 3 or more flashes per second above the general flash threshold
- All settings are stored in `chrome.storage.sync` and sync across devices
- No data leaves your device — everything runs locally

---

Built by **The Thinkers** — Jun Woo Kim, Adina, Lucas, Luai

# Break Speed Coach — GitHub Pages Edition

Fully static PWA for measuring pool break-shot speed. All audio analysis runs client-side via the Web Audio API. All data is stored locally in the browser via localStorage. No server required.

## How it works

1. User records 1–5 break shots using their phone's microphone (or uploads audio files).
2. The Web Audio API decodes the audio to PCM.
3. A JavaScript port of the same DSP pipeline runs in the browser: high-pass filter → amplitude envelope → peak detection → cluster pairing → confidence scoring → speed estimation.
4. Results are saved to localStorage under a player profile.
5. Trend charts (Chart.js) are built from local history.

## Tech stack

- **Vite** — bundler, dev server
- **Vanilla JS ES modules** — no framework
- **Web Audio API** (`AudioContext.decodeAudioData`) — browser-native audio decoding
- **Chart.js 4** — trend charts (CDN)
- **localStorage** — persistence (profiles, sessions, outcome tags)
- **GitHub Actions** → **GitHub Pages** — deployment

## Local development

```bash
npm install
npm run dev
```

## Deploy to GitHub Pages

1. Push this directory as the root of a GitHub repository.
2. In GitHub → Settings → Pages, set **Source** to **GitHub Actions**.
3. The `.github/workflows/deploy.yml` workflow will run on every push to `main` and deploy to GitHub Pages.
4. After the first successful deploy, add your custom domain in Settings → Pages if needed.

## Custom domain

`public/CNAME` contains `www.promethean-games.com`. Update this to match your domain.

Add DNS records:
- `www` CNAME → `<your-github-username>.github.io`
- Apex `@` A records → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`

## Key files

| File | Purpose |
|---|---|
| `src/analyzer.js` | Browser-side DSP engine (port of breakAnalyzer.js) |
| `src/store.js` | localStorage data layer |
| `src/app.js` | Main UI / app logic (adapted from Replit build) |
| `src/styles.css` | All styles |
| `index.html` | Vite entry point |
| `public/sw.js` | Service worker (offline support) |
| `public/manifest.webmanifest` | PWA manifest |
| `public/CNAME` | Custom domain for GitHub Pages |
| `.github/workflows/deploy.yml` | GitHub Actions deploy |

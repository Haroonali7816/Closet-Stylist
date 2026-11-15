# Closet Stylist

An open-source AI stylist for the clothes you already own. Photograph yourself and your wardrobe once. Then say where you're going, and a small team of agents picks your outfit, or plans a whole trip with a packing list.

- **Private by design:** no server and no account. Photos and wardrobe live in your browser (IndexedDB). The only thing that leaves your device is the request to Anthropic's API, made with your own key.
- **No build step:** plain HTML and JavaScript modules. Clone it and open it.

## What it does

1. **You:** upload 10–30 photos of yourself. Claude writes a style profile: build, flattering colours, fits to choose and avoid. You can edit it.
2. **Wardrobe:** one photo per piece. Each is auto-tagged with name, category, colour, warmth (1–5) and formality.
3. **Dress me:** three agents run in turn:
   | Agent | Model | Job |
   |---|---|---|
   | Curator | Claude Haiku 5.5 | Keeps only the pieces that fit the occasion, dress code and weather |
   | Combiner | Claude Opus 5.5 | Builds 6 distinct complete outfits from those pieces |
   | Judge | Claude Opus 5.5, high effort | Looks at the actual photos, scores each outfit 1–10 on weather, occasion, colour and fit, and picks a winner |
4. **Plan a trip:** one outfit per part of the trip, a packing checklist, what to leave at home, and what your wardrobe is missing.

**Liked it / Not me** ratings are saved, and your last 15 go into every future request, so suggestions adapt to your taste.

## Run it

You need an [Anthropic API key](https://console.anthropic.com/) and any static file server (ES modules don't load from `file://`).

```bash
git clone <this repo> && cd closet-stylist
python -m http.server 8000      # or: npx serve .
```

Open http://localhost:8000, paste your key under **Settings**, and start adding photos.

It also deploys as-is to any static host (GitHub Pages, Netlify, Cloudflare Pages).

## Project layout

```
index.html          markup and styles
src/app.js          UI: rendering, uploads, the agent pipeline
src/logic.js        pure helpers and every agent prompt (unit-tested)
src/claude.js       calls to Claude via the official @anthropic-ai/sdk
src/store.js        IndexedDB persistence for docs and photos
test/               node --test unit tests
claude-artifact/    single-file version that runs as a claude.ai artifact
```

## Tests

```bash
node --test
```

## Good to know

- **Cost:** a "Dress me" run is three API calls; the Judge's call includes up to 20 photos. Tagging uses the cheap Haiku model.
- **Your key** is stored in this browser's localStorage and sent only to `api.anthropic.com`. Use a key with a spending limit. Don't host a copy with your own key built in.
- **Refusals:** Opus calls enable Anthropic's server-side fallback, so a declined request is retried on a fallback model.
- **Backups:** clearing site data deletes your wardrobe. Export/import is on the roadmap.
- **iPhone photos:** HEIC files need converting to JPEG (or set Camera → Formats → Most Compatible).

## Roadmap

- [ ] Live weather lookup (Open-Meteo, no key needed)
- [ ] Export / import wardrobe backup
- [ ] Evaluation set: real situations with the outfit you'd actually pick, to measure suggestion quality when prompts change
- [ ] Several items in one photo
- [ ] Background removal for cleaner item photos

## Contributing

Issues and PRs are welcome. Keep it dependency-free where possible; prompts live in `src/logic.js` and should come with a test when they change parsing.

## Licence

[MIT](LICENSE)

# The Songbook

My own songbook for playing guitar along with the songs I like, a bit like
Ultimate Guitar but mine. It runs in the browser and on my iPhone (add it to
the Home Screen), and works offline.

**Use it:** https://linkel.github.io/the-songbook/

## What it does

- **Songs:** my Spotify library, plus songs I add by hand.
- **Chords:** worked out from my own recordings, on the phone or the PC. Every
  chart says where its chords came from: detected (a draft to check by ear),
  from the web (with links), or mine.
- **Sheets:** paste chords over lyrics, and the sheet scrolls along with the
  song.
- **Player:** slow a recording down without changing its pitch, shift the
  pitch, loop the hard bits, and have the app strum along. Saved loops show up
  under Practice.

## Good to know

- No copyrighted material goes in this repo: no recordings, lyrics or tabs.
  Chords-only charts are fine. My recordings and sheets stay on my devices; the
  `private/` folder is never committed.
- To put chords I've worked out on the PC onto the phone: Settings → Export
  your charts, then `node tools/add-charts.mjs <file>`, commit and push.
- The optional PC helper (downloads YouTube audio, reached over Tailscale) is
  explained in [helper/README.md](helper/README.md).
- Plain HTML, CSS and JavaScript with no build step. Run it locally with
  `python -m http.server 8320` and open http://localhost:8320/. Tests:
  `cd tests && npm install && npm test`.

The full plan is in [docs/songbook-plan.md](docs/songbook-plan.md).

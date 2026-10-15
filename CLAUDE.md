# The Songbook

My own Ultimate Guitar: a no-build PWA. The full brief is `docs/songbook-plan.md`; read it before working. The visual direction is `docs/design/songbook-mockup.html`.

## Rules
- Git: short casual one-line commit messages, no Co-Authored-By trailer. 
- Never invent chords or a song-to-pattern match. Every chart says where it came from: detected, web (cited), mine, or verified.
- `../pimapeggio` and `../speedy-pitcher` are mine too; copy code from them with a credit comment, and change them when it helps (commit there with the same rules, keep their tests passing, bump their `sw.js` cache, and mention it in your report).
- Plain HTML/CSS/JS with ES modules, no build step. Leave `CACHE` in `sw.js` at `songbook-v1`: I use the browser version, not an installed app, and the service worker is network-first. Start bumping it again only when I say so (still add new files to `ASSETS`).
- Target is an iPhone 12 mini (test 375×752 and 375×630), with 44 px tap targets. Also check 1440×900, in both Mocha and Latte.
- After each piece of work, tell me what you verified and what I still need to test on the phone.

## Running
- App: `python -m http.server 8320 --bind 127.0.0.1`, then http://localhost:8320/
- Tests: `cd tests && npm install && npm test` (with the app served on 8320).
  - While iterating: `npm run quick` (node checks, under a second) plus the browser file for the area changed (`npm run ui`, `player`, `pc`, `part`, `analysis`).
  - The full `npm test` only after significant changes: the end of a phase, or shared code (player, chords, storage, styles). `npm run shots` adds screenshots for phase review.
  - `npm run test:helper`: the GPU checks against the running PC helper, only when its analysis changes.
- Node is fnm's: `~/AppData/Roaming/fnm/node-versions/v24.14.0/installation/node.exe`.
- PC helper (Python 3.12 venv in `helper/.venv`): see `helper/README.md` once it exists.

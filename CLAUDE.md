# The Songbook

My own Ultimate Guitar: a no-build PWA. The full brief is `docs/songbook-plan.md`; read it before working. The visual direction is `docs/design/songbook-mockup.html`.

## Rules
- Git: short casual one-line commit messages, no Co-Authored-By trailer. Ask before pushing.
- Never commit `private/` (my library export, recordings, stems, analysis). Check `git status` before committing.
- Nothing copyrighted in the repo or in replies: no lyrics, tabs, chord sheets, recordings, stems or note transcriptions. Chords-only charts are fine.
- Never invent chords or a song-to-pattern match. Every chart says where it came from: detected, web (cited), mine, or verified.
- `../pimapeggio` and `../speedy-pitcher` are mine too; copy code from them with a credit comment, and change them when it helps (commit there with the same rules, keep their tests passing, bump their `sw.js` cache, and mention it in your report).
- Plain HTML/CSS/JS with ES modules, no build step. Bump `CACHE` in `sw.js` on every change.
- Target is an iPhone 12 mini (test 375×752 and 375×630), with 44 px tap targets. Also check 1440×900, in both Mocha and Latte.
- After each piece of work, tell me what you verified and what I still need to test on the phone.

## Running
- App: `python -m http.server 8320 --bind 127.0.0.1`, then http://localhost:8320/
- Tests: `cd tests && npm install && npm test` (with the app served on 8320).
- Node is fnm's: `~/AppData/Roaming/fnm/node-versions/v24.14.0/installation/node.exe`.
- PC helper (Python 3.12 venv in `helper/.venv`): see `helper/README.md` once it exists.

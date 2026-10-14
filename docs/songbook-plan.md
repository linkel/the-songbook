# The Songbook: plan

The owner's own Ultimate Guitar: a standalone PWA in this repo (`the-songbook`). It borrows code from two sibling repos:
- **`../pimapeggio`**: the guitar synth, chord and pattern data, notation, and the right-hand pattern trainer;
- **`../speedy-pitcher`**: speed and pitch of real recordings, loops, YouTube, and the download helper.

**What it is:**
- A library of the owner's songs, imported once from a saved Spotify export. The app never calls Spotify at runtime.
- Each song opens as a sheet with chords over lyrics, with transpose, simplify, capo and chord diagrams.
- **Play song:** plays through the whole song. It uses either the owner's own recording, split into instrument stems they can turn on and off, or a synth band the app generates from the analysis. The sheet scrolls in time with it.
- **Speed and pitch of the real recording:**
  - 25–150% speed without changing pitch;
  - pitch shifted on its own, in semitones and cents, with the sheet's chords following;
  - A/B and section loops, count-in and a speed trainer;
  - recordings come from files, or from YouTube and other sites through the owner's PC helper.
- Chords come from analysing the audio, from cited chord charts, or from sheets the owner pastes. The owner is happy with acoustic versions, so simple, playable chords are the goal.
- Fingerpicked songs get a picking guide built on Pimapeggio's pattern trainer.

This file is the brief for the agent building it. Read all of it, plus `CLAUDE.md`, and open `docs/design/songbook-mockup.html` before writing code. With the repo served (§2), the mockup is at http://localhost:8320/docs/design/songbook-mockup.html.

## 1. Ground rules (from the owner; not negotiable)

- **Git:** short casual one-line commit messages, no Co-Authored-By trailer. Ask before pushing; the repo has no remote yet. Never commit `private/` (it's in `.gitignore`; check `git status` before every commit).
- **Other repos:** `../pimapeggio` and `../speedy-pitcher` are the owner's too, and **you may change them when it helps**: a URL hook, a shared fix, or pointing speedy-pitcher at the new helper.
  - Commit in that repo with the same git rules.
  - Keep its own tests passing (`../pimapeggio/tests`).
  - Bump its `sw.js` cache.
  - Say what you changed there in your report.
  - Prefer copying code into this repo (with a credit comment) over making this app load files from the other repos.
- **Stack:**
  - Plain HTML/CSS/JS with no build step, using native ES modules (`<script type="module">`).
  - Works offline. The service worker (`sw.js`) is network-first; bump `CACHE` on every change and add new files to `ASSETS`.
  - Large optional assets (WASM, models) are lazy-loaded and cached on first use, not precached.
  - Vendored libraries go in `vendor/` with their licences.
- **Device:** the target is an iPhone 12 mini (375×812; test 375×752 and 375×630), with 44 px tap targets and text readable at arm's length on a music stand. There's also a desktop layout (≥ 860 px).
- **Copyright and private data:**
  - Nothing copyrighted goes in the repo, in test fixtures or in your replies: no lyrics, tabs, chord sheets, recordings, stems, or transcriptions of melodies, bass lines or drums.
  - Chord progressions (chord names in order, bar counts, sections) aren't copyrightable, so chords-only charts may be committed.
  - Everything derived from the owner's audio or sheets stays on their device (OPFS/IndexedDB) or in `private/`, which is gitignored and never deployed.
- **Never invent chords or a song-to-pattern match.** Every chart is labelled:
  - **detected**, by a named detector;
  - **web**, from cited chord charts;
  - **mine**, entered or confirmed by the owner;
  - **verified**, when two independent sources agree or the owner confirmed it by ear.

  A picking pattern is either sourced, described by the owner, or labelled "suggested pattern for an acoustic version". Synth-band parts are labelled "generated" or "transcribed from your recording".
- **Audio:**
  - Schedule everything on the AudioContext clock.
  - Resume the context on pointerup/touchend/click/keydown and handle iOS's "interrupted" state.
  - Set `navigator.audioSession.type = "playback"` and use a Wake Lock while playing.
- **At the end of each phase,** tell the owner what you verified yourself and what still needs testing on the real phone.

## 2. The owner's setup

**Folders:** all under `C:\Users\ironc\git\`, where `the-songbook` is this repo and the other two are siblings.

**Local ports:** pick an unused one if something has changed.

| Port | What runs on it |
|---|---|
| 8320 | this app: `python -m http.server 8320 --bind 127.0.0.1` from the repo root |
| 8318 | Pimapeggio |
| 8317 | speedy-pitcher |
| 8319 | the Spotify import callback (registered in the owner's Spotify app) |
| 8765 | the PC helper (§7.2) |

**Node:** fnm's, at `~/AppData/Roaming/fnm/node-versions/v24.14.0/installation/node.exe`. It may not be on PATH in every shell.

**Python:**
- `python` on PATH is 3.10.6.
- 3.12 and 3.13 are available through the launcher (`py -3.12`).
- Use a 3.12 virtualenv in `helper/.venv` (gitignored) for the PC helper.

**GPU:** NVIDIA RTX 5090 (32 GB), Windows driver 591.86.
- It needs a PyTorch build with CUDA 12.8 or newer (sm_120). Check the current install command on pytorch.org.
- **WSL2** is installed and is the default version, but the only distro is Docker Desktop's. If a model needs Linux, install Ubuntu (§12); CUDA works in WSL2 through the Windows driver. Docker Desktop with GPU containers is another route.

**Tailscale:**
- Being installed on the PC; not on the iPhone yet, and the tailnet is still on default settings.
- It's needed when the phone talks to the PC helper, from Phase 3. Before that phase, walk the owner through:
  - the iPhone app, signed into the same account;
  - HTTPS certificates turned on in the admin console (DNS page);
  - `tailscale serve --bg 8765`.
- Don't change Tailscale settings yourself.

**GitHub:** the account is `linkel`, pushing over SSH, as other repos do. `gh` isn't installed.
- Pages would serve this app at `https://linkel.github.io/the-songbook/`. That's the same origin as Pimapeggio and speedy-pitcher (`/pimapeggio/`, `/speedy-pitcher/`), so the apps share localStorage and IndexedDB.
- Namespace every key and database name with `songbook-`.

## 3. What exists (read these first)

### In this repo

| Path | What's in it |
|---|---|
| `CLAUDE.md` | The short version of the ground rules. |
| `docs/songbook-plan.md` | This plan. |
| `docs/design/songbook-mockup.html` | The visual direction (§5), seven screens: library, chords view, audio analysis, picking (Latte), **sheet (UG style)**, **play song with mixer**, and **speed, pitch and loops on the real recording**. Its tab bar predates the split from Pimapeggio; use the tabs in §4. |
| `private/spotify-library.json` (gitignored) | **The owner's saved song list:** 958 liked songs and 46 playlists (about 830 playlist entries; 7 followed playlists couldn't be read). Fields: `title`, `artist`, `album`, `added`. This first export has no Spotify ids or durations. |
| `tools/spotify-import.mjs` | Refreshes that file. It now also saves `id`, `uri` and `duration_ms`. Run `node tools/spotify-import.mjs e7ead542a58d4196a534c1a2622cf096` from the repo root; it opens a browser login. The client ID isn't a secret (PKCE). |
| `.gitignore` | `private/`, `node_modules/`, `tests/shots/`, Python caches, `.venv/`. |

### In `../pimapeggio` (copy from it; changes allowed, §1)

| Path | What to take from it |
|---|---|
| `patterns.js` | `FAMILIES` and 58 right-hand patterns (step notation `p i m a`, `pB`/`pA` alternating bass, `+` for simultaneous notes, `i4` for a fixed string). Also `CHORDS` (9 open chords; `frets` run low E to high E, with bass/alt strings), `EXTRA_VOICINGS`, `parseVoicing("x20033")`, `resolveChord`, `parseProgression("C \| G/B \| Am7 G/B")`, `chordMidi(chord, string, capo)`, `noteString`, `BUILTIN_PROGRESSIONS`. Has `module.exports` for node. |
| `notation.js` | `notationSvg(steps, chord, home, npb)`: a small staff-notation SVG of a pattern. |
| `app.js` (~1500 lines, classic globals) | Audio: `renderPluck` (additive pluck synth), `getPluckBuffer`, `playNote(string, midi, time)`, `playClick`, `silenceNotes`, the limiter. The lookahead scheduler: `startSession`, `schedTick`, `scheduleStep`, `chordAt`. The display loop (visual event queue drawn in rAF against `ctx.currentTime - outputLatency`). The practice stage: `buildFingers`, `buildDiagram`, `layoutStage`, the progression strip. |
| `suggestions.json` | 12 songs and 2 pieces with patterns, confidence and sources, plus `progressions` (Landslide with capo 3, Dust in the Wind, House of the Rising Sun, Giuliani). These become charts here (§6). |
| `tests/` | A playwright-core plus Chrome harness: phone and desktop viewports, tap-target and overflow checks, timing checks via `page.evaluate`. Copy its approach for `tests/` here. |

### In `../speedy-pitcher` (copy from it; changes allowed, §1)
A tested practice player, as a no-build PWA with ES modules. Read its `README.md` first.

| Path | What's in it |
|---|---|
| `js/engine.js` | `FileEngine`: Signalsmith Stretch playback with speed, pitch and formant, seamless A/B loops, count-in and a speed trainer, all scheduled on the audio clock. Also `audioContext()`, `resumeAudio`, `makeClick`, `STRETCH_CONFIG`. |
| `js/youtube.js` | `YouTubeEngine`: the same interface over the YouTube IFrame player (speed and loops, no pitch). |
| `js/analysis.js` | Decoding, waveform peaks, `estimateTuning`. |
| `js/waveform.js` | `WaveView`: zoom, pan and pinch, with A/B handles. |
| `js/library.js` | IndexedDB `speedy-pitcher` with `songs` and `blobs` stores. |
| `js/practice.js` | Trainer math and formatting. |
| `js/bench.js` | The "Test stretch speed" benchmark. |
| `vendor/signalsmith-stretch/` | MIT, **with a local scheduling patch**; read its README. |
| `helper/yt_helper.py` | yt-dlp download helper: `/ping` and `/audio?url=`, CORS for `https://linkel.github.io` plus localhost, reached from the phone over Tailscale. |

Its README also records the time-stretch comparison (Signalsmith vs SoundTouch vs Rubber Band) and why it uses 200 ms blocks.

## 4. Realities that shape the design

1. **The library comes from a file, not the API.**
   - When the app is served locally, it loads `private/spotify-library.json` if it exists. A 404 is fine.
   - On the phone, or any time, Settings has **Import library file**, which stores the library in IndexedDB.
   - The owner can also **add songs by hand**, for songs that aren't on Spotify.
   - No Spotify login in the app; refreshing is just re-running the tool.
   - **Songs already in speedy-pitcher:** on GitHub Pages it's the same origin, so the app can read its IndexedDB directly and offer a one-time import of recordings, loops and settings. Locally the ports differ, so offer import from an exported file.
2. **Chords for every song.** There's no free, legal chord database, so a chart comes from:
   - **analysing a recording** (§7), which works for any song and is the main path;
   - **cited web chord charts** (chords only), used to confirm detections;
   - **the owner's pasted sheets.**
3. **Lyrics.** They come from the owner's pasted sheets, stored on the device only, or optionally from a runtime LRCLIB lookup (§12). They're never stored in the repo. For the sheet to scroll in time with playback, lyric lines need timestamps (§8.3).
4. **Audio files.** Spotify streams can't be analysed (DRM, and no previews for new apps).
   - The owner's own files work: mp3 from Amazon or Bandcamp, Apple/iTunes m4a (DRM-free AAC), flac, wav. Buying files is the clean route. Keeping a purchased file on your own device and analysing it for practice is ordinary personal use. This isn't legal advice; the hard line is never committing, uploading or deploying the files or anything derived from them.
   - **Links (YouTube and any other site yt-dlp supports):** the owner already chose this route in speedy-pitcher. The PC helper downloads the audio over the home connection, and the phone reaches it through Tailscale.
     - Downloading is against YouTube's Terms of Service; that's the owner's decision, already made.
     - A browser can't fetch YouTube audio by itself; speedy-pitcher's README explains why.
     - Without the helper, a YouTube link still plays in the embedded player, with speed and loops but no pitch, stems or analysis.
5. **Limits of analysis:**
   - Chords: good on major and minor triads, weaker on 7ths, sus chords, slash chords and fast changes.
   - Key: confuses relative major and minor.
   - Tempo: can be off by a factor of 2.
   - Stem separation: good, with some bleed.
   - Melody, bass and drum transcription: usable, but the synth band will sound like a MIDI rendition, and its "vocals" are a melody line, not sung words.

   Treat every result as a draft, with easy correction and play-along checking.

## 5. Architecture

**Layout:**

```
the-songbook/
  index.html  manifest.json  sw.js  style.css  icon-*.png
  js/
    app.js        tabs, routing (#/song/<id>/<mode>), settings, init
    audio.js      the one AudioContext, limiter, mixer bus, pluck synth, strum, click, band voices
    scheduler.js  lookahead scheduling and the visual event queue (from pimapeggio)
    engine.js     FileEngine + Signalsmith (from speedy-pitcher), YouTubeEngine in youtube.js
    chords.js     chord engine (§5 below)
    patterns.js   copied from pimapeggio, converted to an ES module (keep a node-testable export)
    notation.js   copied from pimapeggio
    library.js    library, charts, sheets, timing, prefs (IndexedDB songbook-*), OPFS audio
    songs.js      Songs tab and song list
    sheet.js      Sheet and Chords modes
    picking.js    Picking mode (the pimapeggio stage)
    player.js     Play song: recording and synth band, mixer, loops, trainer
    analysis.js   worker host for essentia.js; analysis-worker.js
    waveform.js   from speedy-pitcher
    helper-client.js  talks to the PC helper
  songs/          index.json + <id>.json: shipped chords-only charts
  vendor/         signalsmith-stretch, essentia.js (lazy), chords-db subset, fflate
  helper/         songbook_helper.py (PC side, §7.2)
  tools/          spotify-import.mjs
  tests/          package.json (playwright-core), unit and browser checks
  docs/           this plan, the mockup
  private/        gitignored: library export, audio, analysis bundles
```

**Tabs:** **Songs · Practice · Settings** (bottom bar, mockup style).
- **Songs** is the library.
- **Practice** lists the loops and sections the owner is working on across songs (with speed-trainer progress), plus the pattern trainer for picking.
- A song opens full-screen at `#/song/<id>`, with modes **Sheet** (the default when lyrics exist), **Chords**, **Picking** and **Player**.

**One AudioContext for everything:**
- Base it on speedy-pitcher's `audioContext()`: latencyHint "playback", audio session "playback", resume on gestures.
- Everything shares it: Pimapeggio's synth and click, the stretch node, stems, and the YouTube count-in.
- One limiter and mixer bus.

**Chord engine** (`js/chords.js`):
- Parse any chord name (root, quality, slash bass) and transpose it with spelling that fits the key.
- Fingerings come from a vendored subset of **chords-db** (github.com/tombatossals/chords-db; confirm it's still MIT and credit it), with E-shape and A-shape barre forms as the fallback.
- **Simplify** for an acoustic version, with a toggle.
- **Capo suggestion:** choose capo 0–7 so the shapes are the easiest.
- Output is compatible with Pimapeggio's `chordMidi`/`noteString`, so its patterns play over any chord.

**Audio** (`js/audio.js`, `js/engine.js`):
- Strum synthesis: staggered `playNote` calls, with down and up strokes and text strum patterns like `"D - D U - U D U"`.
- Bass, drum and lead voices for the synth band.
- Mixer: one GainNode per track.
- **Speed and pitch of recordings:** port speedy-pitcher's `FileEngine` and the vendored **Signalsmith Stretch**. Keep its scheduling patch, `STRETCH_CONFIG` (200 ms blocks, `splitComputation`) and the benchmark. Don't switch to SoundTouch or Rubber Band; speedy-pitcher's comparison already rejected them.

**Storage:**
- Shipped: `songs/index.json` plus `songs/<id>.json`.
- On the device:
  - IndexedDB `songbook`: `library`, `charts`, `sheets`, `lyricTiming`, `arrangements`, `loops`, `songPrefs`;
  - **OPFS** for audio and stems; call `navigator.storage.persist()`.
- On the PC: `private/songs/<slug>/` (analysis bundles).
- Export/Import backup in Settings (JSON; audio optional and kept separate).

## 6. Design: Ultimate Guitar layout, Yelp-style components, Catppuccin colors

The reference is `docs/design/songbook-mockup.html`.

**Sheet view (the heart of the app, mockup 5), modelled on Ultimate Guitar's chords view:**
- **Header:** title and artist, plus the source badge.
- **Toolbar:** Transpose −/+, Simple, Aa (font size, persisted per song), Capo.
- **Info line:** key (and sounding key when capoed), capo, tempo, strum pattern.
- **Section tags:** [VERSE 1], [CHORUS] and so on.
- **Lyric lines with chords above the syllable they change on.**
  - Render each chord–text pair as an inline-block segment, not a monospace `<pre>`, so lines wrap cleanly at 375 px.
  - A chord with no text under it still sits on the chord row.
- **Tap a chord** for a popover with its diagram, alternate voicings, and a tap to hear it.
- **Chord diagram strip** at the bottom.
- **Auto-scroll:** by speed, or in sync with Play using lyric timestamps. The current line gets a peach left border and tint, and the current chord gets a peach fill.
- **Transport:** "Scroll 1×" and **Play song**.
- **Desktop:** the sheet in a wide column, and a side panel with chord diagrams, the mixer and the transport.

**Component style:** borrow Yelp's *structure* only, not its red, logo, stars or anything food-related:
- cards with a 1 px border and a soft two-layer shadow;
- a prominent rounded search bar;
- pill filters with borders;
- one filled primary button per screen, with other buttons outlined;
- list rows with square art and badges;
- a bottom tab bar with icons.

**Colors:** the Catppuccin palette (MIT).
- Mocha (dark) and Latte (light). Follow `prefers-color-scheme`, with a manual override in Settings.
- Tokens are CSS custom properties on `:root[data-theme=…]`.

| Role | Mocha | Latte |
|---|---|---|
| Page / card | mantle `#181825` / base `#1e1e2e` | mantle `#e6e9ef` / base `#eff1f5` |
| Borders | surface0 `#313244` / surface1 `#45475a` | surface0 `#ccd0da` / surface1 `#bcc0cc` |
| Text / meta | text `#cdd6f4` / subtext0 `#a6adc8` | text `#4c4f69` / subtext0 `#6c6f85` |
| Primary and chord names in the sheet | mauve `#cba6f7` | mauve `#8839ef` |
| Now playing (line, chord, bar) | peach `#fab387` | peach `#fe640b` |
| Badges: verified/mine, detected, needs audio, picking | green, yellow, overlay, blue | same |
| Fingers p, i, m, a | peach, blue, green, pink | same |

**Shapes:** card radius 12, button radius 10, pills fully rounded. Tap targets ≥ 44 px, and 48 for the transport. Check text contrast against WCAG AA in both flavors.

## 7. Data model

### Chart

```json
{
  "id": "landslide",
  "title": "Landslide", "artist": "Fleetwood Mac", "spotify": null,
  "key": "Eb", "capo": 3, "time": "4/4", "tempo": null,
  "style": "fingerpicked", "strum": null,
  "voicings": { "G/B": "x20033" },
  "sections": [
    { "name": "Intro", "chords": "C | G/B | Am7 | G/B", "repeat": 2,
      "picking": { "pattern": "travis", "match": "family", "source": "mine" } }
  ],
  "form": ["Intro", "Verse", "Chorus", "Verse", "Chorus"],
  "source": "web", "detector": null, "confidence": "high",
  "sources": [{ "label": "…", "url": "https://…" }],
  "notes": "One chord per bar here; verify the timing by ear."
}
```

- `chords` uses Pimapeggio's bar syntax: `|` between bars, and several chords in a bar split it evenly.
- `form` gives the order the sections play in, for Play song and the timeline.
- Detected charts add per-bar `strength` and a `beats` array: times in seconds from the recording.
- **Seed data:** the 12 songs and 2 pieces in `../pimapeggio/suggestions.json` become charts in `songs/`, keeping their sources, confidence and pattern ids. Studies stay in Pimapeggio.
- `tests/data.test.mjs` validates shipped charts: chords parse, pattern ids exist, `web` charts have sources, and there are no lyric-like fields.

### Sheet (owner's, device only)
- ChordPro text (`{title}`, `{capo}`, `{start_of_chorus}`, inline `[Am]`), linked to a library song.
- Paste import accepts ChordPro or chords-over-lyrics text: chord-only lines are merged into the lyric line below by character column, and headings like `[Verse]` are recognised.
- Unit-test the parser with **made-up** lyrics only.

### Lyric timing (device only)
`{ songId, lines: [{ index, t }] }`: seconds into the recording for each sheet line.

### Arrangement (synth band; device or `private/` only)
`{ songId, tempo, beats, tracks: { guitar, bass, drums, melody } }`. Each track is `{ kind: "generated" | "transcribed", events: [{ t, dur, midi, vel }] }`, with drums as `{ t, drum: "kick" | "snare" | "hat" | "crash", vel }`.

## 8. Audio analysis

### 8.1 In the browser (phone and PC)
- **essentia.js** (MTG/UPF; AGPL-3.0, which is fine for a personal app whose source is public) runs in a Web Worker, lazy-loaded.
- **Pipeline:**
  1. `decodeAudioData`, mono, 44.1 kHz.
  2. **Tempo and beats:** `RhythmExtractor2013`, with ×2/÷2 offered in the UI.
  3. **Key:** `KeyExtractor`. Compare profiles `edma`, `bgate` and `temperley` on test material.
  4. **Chords:** `HPCP`, then `ChordsDetectionBeats`.
  5. **Post-processing:**
     - snap changes to beats;
     - merge segments shorter than one beat;
     - drop "N";
     - take the majority chord per half bar;
     - estimate downbeats, with a "this is beat 1" tap;
     - propose sections from repeated 4- and 8-bar blocks, plus a `form`.
  6. Simplification and the capo suggestion.
- The result is a **detected** chart with the detector name and version. Bars with low confidence show "?" (mockup 3).
- **Batch mode:** many files, processed one at a time with a progress list. Match each file to a library song by its tags (ID3/MP4) and duration, and confirm uncertain matches.

### 8.2 On the PC: `helper/songbook_helper.py`
**One helper.** Start from speedy-pitcher's `yt_helper.py`. Keep `/ping` and `/audio?url=` exactly, so speedy-pitcher can point at this helper too. Keep port 8765. CORS allows `https://linkel.github.io` and localhost. Add:
- `POST /analyze`, taking an audio file or `?url=`. It queues a job and returns a job id.
- `GET /jobs/<id>`, for progress.
- `GET /bundle/<id>.zip`, for the result.

The phone reaches it over Tailscale (`tailscale serve --bg 8765`). The flow: paste a link on the phone, the PC downloads and analyses it on the RTX 5090, and the phone receives the bundle into OPFS.

**First evaluate ChordMini** (github.com/ptnghia-j/ChordMiniApp, MIT). Its Python backend already does large-vocabulary chords (BTC, Chord-CNN-LSTM), beat tracking and more. Calling it from the helper may beat writing our own. Otherwise:
- **Stems:** Demucs (htdemucs; 4 stems, or 6 including guitar and piano). Check which repo is maintained now.
- **Beats, downbeats and sections:** allin1 (mir-aidj/all-in-one, MIT) or beat_this (CPJKU, ISMIR 2024).
  - allin1 depends on NATTEN and a madmom fork, which may not build on Windows. If so, run the helper in WSL2 Ubuntu or a GPU Docker container (§12), or fall back to beat_this plus our own section finder.
- **Chords:** a BTC large-vocabulary model run on the "other" plus "bass" stems, with Chordino as a baseline.
- **Transcription for the synth band:** basic-pitch (Apache-2.0) on the vocal and bass stems. Drums come from a drum-transcription model on the drum stem, or from onset classes as a fallback.
- **Lyric alignment:** force-align the owner's pasted lyrics to the vocal stem (e.g. WhisperX or stable-ts; check what's current).
- **Setup:** `py -3.12 -m venv helper/.venv`, then PyTorch for CUDA 12.8 or newer, then the models. Write the steps in `helper/README.md`, along with Tailscale setup (reuse speedy-pitcher's README section).
- **Output:** a bundle at `private/songs/<slug>/` (`chart.json`, `arrangement.json`, `timing.json`, `stems/*.m4a`), plus `<slug>.zip` for manual import as a fallback.

### 8.3 Checking a chart
- **Play along:** the recording, with bars highlighted on its own clock and an optional soft strum layer.
- Tap a bar to edit it with a chord picker (chords in the key first); long-press to split a bar.
- **Mark as checked** turns the chart into "mine".
- If a web chart exists for the song, show where the two agree and disagree.

## 9. Play song

### 9.1 Recording mode (mockups 6 and 7)
- **Source:** the owner's file, or its stems when a bundle exists.
- **Mixer:** one row per stem, each with mute and volume. There's also an **app guitar** row: the chart strummed or picked by the app's synth, in time with the recording's beats.
- **Speed and pitch:**
  - speed 25–150% with pitch kept;
  - pitch ±12 semitones plus ±50 cents, with an optional formant setting;
  - **Match my tuning** (`estimateTuning`).
- **Chords follow pitch:** shifting by n semitones transposes the sheet, the chord lane and the diagrams by n, and recomputes the capo suggestion. The app guitar layer plays at the same cents offset as the recording.
- **Loops and practice:**
  - A/B loops on the waveform with section and chord lanes;
  - one-tap "loop this section" or "loop bars 9–12" that snap to analysed bar lines;
  - named saved loops, which show up in the Practice tab;
  - count-in at the song's tempo, scaled by speed;
  - the speed trainer;
  - Media Session lock-screen controls.
- **Stems through the stretcher:** try these in order, measuring with the benchmark on the iPhone 12 mini:
  1. One Signalsmith node with all the stems as input channels, then per-stem gains after a ChannelSplitter.
  2. When mute or volume changes, re-mix the stems into one buffer and swap it in at the current position.
  3. On the PC only, one node per stem.

  Pick the first one that runs without dropouts.
- **Keeping things in sync while slowed:** convert song time to context time through the engine's schedule (`plan`/`posAt`). The sheet highlight, lyric lines, chord lane and app guitar all follow song time, so they stay locked at any speed and through loop jumps.
- **YouTube without the helper:** `YouTubeEngine`. Speed and loops work, but pitch, stems and play-along analysis are greyed out with a "needs the helper" note. The sheet can still follow by tap-to-sync timing.

### 9.2 Synth band mode
- **Parts:** from the arrangement. Transcribed tracks are labelled as such; otherwise parts are **generated** from the chart: bass from roots and fifths, drums from a groove chosen by meter and tempo, and guitar from the strum or picking pattern.
- **Voices:** pluck guitar, low pluck bass, synthesized kick, snare and hat, and a soft lead labelled "melody". The app doesn't synthesize sung lyrics.
- **Controls:** the same mixer, any tempo with no artefacts, and transpose applied to every part. It works for every song with a chart, even without a recording.

### 9.3 Lyric timing
Without timestamps, the sheet auto-scrolls at a set speed. Timestamps come from:
- **tap-to-sync:** play the recording and tap as each line starts, then nudge any line;
- **PC alignment** (§8.2);
- **LRCLIB**, if the owner enables it (§12).

## 10. Phases

Each phase ends with tests passing, screenshots reviewed at 375×752, 375×630 and 1440×900 in both Mocha and Latte, a commit, and a report to the owner.

- **Phase 0: scaffold.**
  - App shell (index.html, manifest, sw.js, tabs, routing), design tokens and components from the mockup, the theme switch.
  - `tests/` harness: copy pimapeggio's approach, on port 8320.
  - Copy and convert `patterns.js` and `notation.js`, plus the pluck synth and scheduler from pimapeggio's `app.js`, into modules.
  - Chord engine with chords-db, simplification and capo suggestion, plus unit tests.
  - Strum synthesis and the mixer bus.
  - Seed charts from pimapeggio's `suggestions.json`.
- **Phase 1: library and sheet.**
  - Library from the file (§4.1), adding songs by hand, and the Songs tab per mockup 1 (search, pills, lazy rows for about 1,800 entries, status badges).
  - Song view in Chords and Sheet modes.
  - Paste a sheet, with the UG-style sheet view, toolbar, chord popovers, diagram strip and auto-scroll by speed.
  - Play strums the chart in synth.
- **Phase 2: analysis in the browser.** Single file, then batch. The review screen with play-along, editing and "mark as checked". Recordings stored in OPFS.
- **Phase 3: recording player, from speedy-pitcher.**
  - Port `FileEngine` and Signalsmith, `YouTubeEngine`, `WaveView`, `estimateTuning`, the trainer and the benchmark.
  - Speed, pitch and tune; chords that follow pitch; loops snapped to bars and sections, saved to Practice; count-in; Media Session.
  - The app guitar row, tap-to-sync lyric timing, and the synced sheet at any speed.
  - The speedy-pitcher library import.
  - YouTube links: the embedded player, plus downloads through `helper/songbook_helper.py`. At this stage it's only the download part, copied from `yt_helper.py`.
- **Phase 4: picking guide.**
  - The Picking mode, as in mockup 4: Pimapeggio's stage (letters, string diagram, notation) over the section's chords, played with the scheduler.
  - Sourced, owner-described or suggested patterns, each clearly labelled.
  - "Open in Pimapeggio": add URL parameters to Pimapeggio (pattern, progression, capo) and link to it for the full trainer with ratings and the tempo ladder.
- **Phase 5: helper analysis on the GPU** (§8.2).
  - Evaluate ChordMini first.
  - Then stems, better chords and sections, lyric alignment, jobs started from the phone, and bundles straight into OPFS.
  - Stem rows join the mixer (§9.1).
- **Phase 6: synth band** (§9.2): generated parts first, then transcribed parts from Phase 5 bundles.
- **Phase 7, optional:** a web research pass for cited chord charts (chords only), and LRCLIB. Each one only if the owner approves (§12).

## 11. UI notes and testing

**UI:**
- **Mockup screens:** 1 library · 2 chords view · 3 analysis · 4 picking (Latte) · 5 sheet · 6 play song with mixer · 7 speed, pitch and loops.
- **Desktop shortcuts:** Space play/pause, ↑/↓ tempo or speed, ←/→ transpose, S toggles auto-scroll, L loops the current section, M opens the mixer, Esc goes back.
- Test with invented lyrics, like the mockup's example song. Never show the owner's real sheets or lyrics in shared screenshots.

**Tests** (in `tests/`: `npm install`, serve on 8320, `npm test`):
- **Unit:** chord engine, ChordPro and chords-over-lyrics parsers (invented lyrics), analysis post-processing on synthetic arrays, generated bass and drum parts, the bundle format, and the shipped charts.
- **Analysis and sync accuracy:**
  - Render test songs with the app's own synth: known progressions, keys and tempos.
  - Assert that tempo is within ±2 bpm (or ×2), the key is correct (or the relative major/minor), and at least 85 % of bars have the right triad.
  - Assert that the play-along highlight is within 50 ms of the bar times.
  - Commit the generator, never audio.
- **Browser checks** (both flavors, all three sizes):
  - no overflow, and tap targets ≥ 44 px;
  - the library scrolls and searches;
  - the sheet wraps at 375 px with chords above their syllables;
  - transpose, capo and simplify change the sheet and the sound;
  - the mixer affects the right track;
  - speed keeps the pitch, and pitch shift lands within 2 cents (speedy-pitcher's test-tone method);
  - loop jumps are seamless, and count-in lands on the beat at 50% and 75% speed;
  - a −2 pitch shift renames the chords;
  - the highlight stays on the right bar at 50% speed and across a loop jump;
  - OPFS round-trips a file;
  - bundle import;
  - data survives a reload;
  - the app works offline after the first load.
- **For the owner to test on the phone:**
  - analysis speed and chord quality on real songs;
  - picking files from the Files app;
  - OPFS persisting for days;
  - audio resume after calls or Siri;
  - stem sync and CPU with time-stretch ("Test stretch speed");
  - YouTube embed playback;
  - the helper over Tailscale (download and analysis);
  - auto-scroll on a stand.

## 12. Open decisions for the owner (ask before the phase that needs them)

1. **Theme:** follow the system setting, with Mocha as the dark theme? Recommended: yes. *(Phase 0)*
2. **Keep recordings on the phone** (OPFS, about 3–10 MB per song, more with stems)? Recommended: yes, with a storage meter and per-song delete. *(Phase 2)*
3. **Import speedy-pitcher's existing library?** Recommended: yes, once both are on Pages. *(Phase 3)*
4. **Lyrics:** pasted only (default), or also LRCLIB lookup with synced timestamps? *(Phase 3)*
5. **Cross-repo changes:** answered. Changes to Pimapeggio and speedy-pitcher are allowed (§1), e.g. Pimapeggio URL parameters for "Open in Pimapeggio", and pointing speedy-pitcher at the new helper.
6. **PC helper:** try the ChordMini backend first, or build our own analysis? If some models need Linux, install Ubuntu in WSL2 (`wsl --install -d Ubuntu-24.04`), or use a GPU Docker container? *(Phase 5)*
7. **Hosting:** GitHub Pages at `https://linkel.github.io/the-songbook/` needs a remote and a push. Only public code is deployed; `private/` never is. Should `docs/` (the mockup shows some of the owner's song titles) be public? *(any time)*

## 13. Prompt to hand to the agent

> Build The Songbook described in `docs/songbook-plan.md` in this repo (`the-songbook`, a no-build PWA). It's my own Ultimate Guitar: my saved library (`private/spotify-library.json`, no Spotify API at runtime), UG-style chords-over-lyrics sheets, audio analysis for chords, a Play song player with a mixer, and speed and pitch of real recordings brought in from my `../speedy-pitcher` app, with Pimapeggio's (`../pimapeggio`) guitar synth and picking patterns. Read `CLAUDE.md`, the whole plan, the files listed in §3 (including speedy-pitcher's README), and the mockup at `docs/design/songbook-mockup.html` before starting. You may change the sibling repos when it helps (§1). Follow §1 exactly: nothing copyrighted or derived from my recordings goes in the repo or in your replies; never commit `private/`; every chart is labelled detected, web (cited), mine or verified, and you never invent chords or patterns; short casual one-line commits with no Co-Authored-By; ask before pushing. Work phase by phase (§10), starting with Phase 0. At the end of each phase, run `tests/` (serve the repo on 8320), review screenshots in Mocha and Latte, commit, and tell me what you verified and what I still need to test on my iPhone 12 mini. Ask me the §12 questions when you reach the phase that needs them.

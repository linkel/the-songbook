# The Songbook's PC helper

`songbook_helper.py` runs on your PC at home and does two jobs:

1. It **downloads a link's audio** (YouTube and anything else yt-dlp supports), so
   the Songbook can change its pitch, draw its waveform and analyse its chords.
2. It **analyses recordings on the PC's GPU** (Phase 5a): stems, beats and bar
   lines, chords, sections, and your pasted lyrics lined up with the singing.
   The results come back to the phone as a bundle.

Your phone reaches it privately over **Tailscale**.

It started as speedy-pitcher's `helper/yt_helper.py`. It keeps the same
download endpoints (`/ping`, `/audio?url=`) and port (8765), so speedy-pitcher
can use this helper too: put the same address in its Settings.

Downloading from YouTube is against YouTube's Terms of Service; that's your
call, and you've made it. Audio goes between your PC and your phone and nowhere
else. The analysis bundles go in `private/songs/` (gitignored); to ship a song with
the app, recording, stems, chart and guitar part included, run
`node tools/ship-bundle.mjs private/songs/<song>` (or `--all`) and commit `songs/`.

When the detected part isn't right and you have a tab of the same performance
as a Guitar Pro file (GP7/GP8 `.gp`), line it up with the recording and use it
instead, then ship as above:

    wsl -d Ubuntu-24.04 -- bash -lc "source ~/.venvs/songbook/bin/activate && python helper/import_gp.py private/songs/<song> 'private/<tab>.gp' --from Songsterr --url <link>"

The bars, chords (named from the tab's notes) and part come from the tab, the
bar times from the recording; both say where they're from. The detected chart
and part stay in the bundle as `chart.detected.json` and `part.detected.json`.
`python helper/test_gp.py` checks the tab reader.

## What the analysis uses

| Step | What does it | Licence |
|---|---|---|
| Stems: vocals, guitar, bass, drums, piano, other | [Demucs](https://github.com/adefossez/demucs) `htdemucs_6s` | MIT |
| Beats and downbeats (bar lines, 3/4 or 4/4) | [beat_this](https://github.com/CPJKU/beat_this) (CPJKU, ISMIR 2024) | MIT |
| Chords (170 kinds: triads, 6ths, 7ths, sus, dim, aug) | [ChordMini](https://github.com/ptnghia-j/ChordMini)'s BTC model (`btc_model_best.pth`), run on the stems without the vocals | MIT |
| Slash chords (G/B) | the bass stem's note, when it's clearly the chord's third or fifth | ours |
| Key, tuning, bars, sections | key profiles (Krumhansl, Temperley), librosa's tuning estimate, the app's half-bar rule, bar blocks that repeat by chords and sound | ours |
| Lyric timing | [stable-ts](https://github.com/jianfch/stable-ts) on Whisper large-v3, aligning your pasted lines to the vocal stem | MIT |
| Guitar part (Phase 5b, when asked) | [basic-pitch](https://github.com/spotify/basic-pitch) (Apache-2.0) for the notes of the guitar stem, then our own pass (`parts.py`): strings and frets in your tuning and capo by dynamic programming, the picking fingers by rule, bars quantized and matched to the library's patterns | ours |

Every result is a draft: the chart says "detected" and names these detectors.

**Why not ChordMini's whole backend?** It's the plan's first choice, so it was
tried first (2026-10-14). Its Flask backend pins PyTorch 2.6 and TensorFlow
2.15 on Python 3.10, plus Spleeter and madmom. PyTorch 2.6 has no build for
the RTX 5090 (sm_120), so it would run on the CPU, and its own README says
native Windows installs aren't reliable. Its *model* repo (ChordMini, MIT,
PyTorch 2.9, checkpoints included) works fine, so the helper calls that
directly. allin1 (sections by name) was skipped: it needs NATTEN, which would
have to be built against CUDA here. beat_this does the beats instead, and the
helper finds the sections itself.

**Guitar parts.** The picking hand can't be heard: p/i/m/a come from a rule
(the lowest note on the chord's bass strings is the thumb, the rest by their
home strings), and the part says so. basic-pitch hears too much on a picked
guitar (overtones, strings still ringing, a stem's pre-echo), so its notes are
cleaned first. The tab models the plan suggested (TabCNN with inhibition,
FretNet, TART, the Fretting-Transformer) publish no weights to run, so strings
come from the dynamic-programming pass alone; training TabCNN on GuitarSet is
possible later. On parts rendered by the app's synth (`tests/pc.test.mjs`): 97%
of notes at the right pitch within 30 ms, 95% on the right string, and the
right library pattern in 89% of bars, in standard tuning and open D. A string
played again while it still rings is the weak spot.

**Measured on the RTX 5090** with songs rendered by the app's synth
(`tests/pc.test.mjs`): tempo within 1 bpm and the key right on all 6, 100% of
bars right as triads, the AABB form found, D/F♯ named, and stems that add back
up to the song within 0 samples. A 5-minute song takes about 25 s, plus about
10 s to load the models the first time. Lyric timing on two real songs: a
median of 0.15 s from Whisper's own word times, with two or three lines per
song off by 2–5 s (nudge those with tap-to-sync).

## 1. Install

### Downloads only (Windows, about 5 minutes)

From the repo root, in PowerShell:

```powershell
py -3.12 -m venv helper\.venv
helper\.venv\Scripts\python -m pip install -r helper\requirements.txt
helper\.venv\Scripts\python helper\songbook_helper.py
```

The phone's "Analyse on your PC" then says this helper only downloads.

### With analysis: WSL2 Ubuntu (about 15 minutes, 15 GB)

The models want Linux, so the helper runs in Ubuntu under WSL2 on the same PC.
CUDA works there through the Windows NVIDIA driver; nothing else to install on
Windows. Ubuntu 24.04 is already installed (`wsl -l -v` lists `Ubuntu-24.04`),
with a user `ironc` that has no password yet. To set one, for `sudo`:
`wsl -d Ubuntu-24.04 -u root passwd ironc`.

In PowerShell, from the repo root:

```powershell
wsl -d Ubuntu-24.04 -- bash helper/setup-wsl.sh
```

This installs uv, a Python 3.12 venv in `~/.venvs/songbook` (inside Ubuntu,
not in the repo), PyTorch for CUDA 12.8, the libraries in
`requirements-gpu.txt`, and ChordMini's code and checkpoints in
`~/src/ChordMini-model` (pinned to a tested commit). The models download on
the first analysis: Demucs and beat_this (about 0.2 GB) and Whisper large-v3
(3 GB, only when you send lyrics). It's safe to run again.

## 2. Run it

```powershell
wsl -d Ubuntu-24.04 -- bash helper/run-wsl.sh
```

(or, downloads only: `helper\.venv\Scripts\python helper\songbook_helper.py`).
It prints `Songbook helper on http://127.0.0.1:8765` and, for analysis,
`Analysis: ready (NVIDIA GeForce RTX 5090)`. Leave the window open while you
use it. Run only one of the two: they share the port.

WSL forwards Ubuntu's `127.0.0.1:8765` to Windows' `127.0.0.1:8765`, so
everything below works the same for either.

**Quick check on the PC:** open <http://127.0.0.1:8765/ping>. You should see
`{"ok": true, ..., "analysis": {"available": true, "gpu": "NVIDIA GeForce RTX 5090"}}`.

When the app runs locally (<http://localhost:8320>), it can use
`http://127.0.0.1:8765` directly: enter that under Settings → PC helper.

**Keep yt-dlp up to date.** YouTube changes often, and an old yt-dlp is the
usual reason downloads fail:

```powershell
wsl -d Ubuntu-24.04 -- bash -c "~/.venvs/songbook/bin/pip install -U 'yt-dlp[default]'"
helper\.venv\Scripts\python -m pip install -U "yt-dlp[default]"
```

## 3. Reach it from your iPhone with Tailscale

Tailscale puts your PC and your phone on a small private network, and
`tailscale serve` gives the helper an HTTPS address that only your devices can
open. The app needs HTTPS, because a page served over HTTPS can't call a plain
`http://` address.

1. **PC:** install Tailscale (you've downloaded it already), run it, and sign in.
2. **iPhone:** install **Tailscale** from the App Store and sign in with the
   **same account**. Allow the VPN configuration when iOS asks, then switch
   Tailscale on.
3. **Admin console:** open <https://login.tailscale.com/admin/dns> on any device:
   - **MagicDNS:** make sure it's enabled (it is by default on new tailnets).
   - **HTTPS Certificates:** click **Enable HTTPS**. This lets `tailscale serve`
     get a real certificate for your PC's name.
4. **PC, in a new PowerShell window** (the helper keeps running in the other one):

   ```powershell
   tailscale serve --bg 8765
   ```

   It prints an address like `https://your-pc.tail1234.ts.net`. `--bg` keeps
   serving after you close the window and across restarts; `tailscale serve
   status` shows it, and `tailscale serve reset` turns it off.
   The first request can take a few seconds while the certificate is issued.
5. **iPhone, in Safari:** open `https://your-pc.tail1234.ts.net/ping`. You should
   see the same `{"ok": true, …}` as on the PC. If it doesn't load, check that
   Tailscale is switched on on the phone and the helper window is still running.
6. **In the Songbook:** Settings → **PC helper**: paste the address and tap
   **Test**. It should say "Connected" and "Analysis ready on NVIDIA GeForce RTX 5090".

Nothing here opens a port on your router or Windows Firewall: the helper only
listens on 127.0.0.1, and Tailscale hands requests to it.

## 4. Use it

- **Analyse a recording:** in a song, Chords → **Chords from audio**. With a
  recording on the phone, **Analyse on your PC** sends it to the PC (and, with
  **Line up my lyrics** on, your sheet's lyric lines). Each step shows as it
  runs, and you can leave the screen: the job carries on, and the results come
  over when you're back. Then check the draft as usual: Play along, fix bars,
  Mark as checked.
- **The guitar part:** on by default ("The guitar part too"). Picking mode
  shows each section's part bar by bar: patterns where they match the
  library, written-out bars where they don't, "?" where it wasn't sure. Play
  it along with the recording, fix bars, then Mark as checked. For a song you
  analysed before, Picking mode's **Find it** runs just the part on the stems
  the PC kept.
- **Analyse a link:** in the Player, next to a YouTube link, **Analyse** has
  the PC download it and analyse it. The recording comes back with the chords
  and stems.
- **Stems:** the Player's mixer gets a row per stem (vocals, guitar, bass,
  drums, piano, other), with **Full mix / Stems** to switch. All of them go
  through one time-stretcher, so speed, pitch and loops work as before. On the
  phone each stem plays in mono to save memory; Settings → **Test stretch
  speed** shows whether six stems keep up on your phone.
- **If the results don't come over** (say the phone lost the connection): the
  bundle is in `private/songs/<song>.zip` on the PC. Settings → **Import an
  analysis bundle** takes that zip.
- **Late July:** the tutorial is played in open D♭. To learn it in open D, open
  the song's Player, tap **Download** next to the tutorial, then raise **Pitch**
  by **+1**. Speed down to taste: the pitch stays where you put it.

## The endpoints

| | |
|---|---|
| `GET /ping` | `{"ok", "yt_dlp", "helper": "songbook", "version", "analysis": {"available", "gpu" or "reason"}}` |
| `GET /audio?url=<link>` | the audio file (m4a when available) |
| `POST /analyze[?url=<link>]` | queues an analysis; multipart form fields: `file` (unless `?url=`), `song`, `title`, `artist`, `lyrics` (JSON `[{index, text}]`), `lang`, `parts=guitar` with `tuning` (notes, low first) and `capo`. With `job=<id>` and `parts=guitar`: just the part, on that earlier job's stems. Returns the job. |
| `GET /jobs`, `GET /jobs/<id>` | `{"state": "queued/running/done/failed/cancelled", "step", "progress", "steps": [{key, label, p}], "error"}` |
| `POST /jobs/<id>/cancel` | |
| `GET /bundle/<id>.zip` | the result |

A bundle is a stored (uncompressed) zip with `bundle.json` (the manifest),
`chart.json` (a detected chart in the app's format, with per-beat chords so bar
lines and tempo can still be changed on the phone), `stems/*.m4a` (AAC, 96 kbps),
`timing.json` when you sent lyrics, `part.json` (each section's guitar part,
plus the notes found) when you asked for it, and `audio.m4a` when the PC
downloaded the recording itself. A part-only job's bundle has just `part.json`.
To try the analysis on one file without the server:

```bash
~/.venvs/songbook/bin/python helper/analysis.py song.mp3 --out /tmp/bundle
```

## Notes

- **Allowed callers.** Browsers may only call the helper from
  `https://linkel.github.io` or its custom domain `https://kellyhuntlin.com` (the deployed app, shared with speedy-pitcher) or
  `localhost`. Add another origin with `--allow-origin https://example.org`.
- **One job at a time** on the GPU, and one download at a time. That's plenty
  for one person and keeps YouTube calm.
- **Limits.** Files up to 200 MB and 20 minutes.
- **Errors.** "Sign in to confirm you're not a bot" usually means yt-dlp needs
  updating (step 2), or YouTube is rate-limiting your IP for a while.
- **Start with Windows (optional).** In Task Scheduler, create a task "At log
  on" that runs `wsl.exe` with the arguments
  `-d Ubuntu-24.04 --cd C:\Users\ironc\git\the-songbook -- bash helper/run-wsl.sh`.

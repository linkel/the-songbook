# The Songbook's PC helper

`songbook_helper.py` runs on your PC at home. Today it does one job: it
**downloads a link's audio** (YouTube and anything else yt-dlp supports), so the
Songbook can change its pitch, draw its waveform and analyse its chords. Your
phone reaches it privately over **Tailscale**. Later phases add chord, stem and
lyric analysis on the GPU.

It started as speedy-pitcher's `helper/yt_helper.py`. It keeps the same
endpoints (`/ping`, `/audio?url=`) and port (8765), so speedy-pitcher can use
this helper too: put the same address in its Settings.

Downloading from YouTube is against YouTube's Terms of Service; that's your
call, and you've made it. The audio goes from your PC to your phone and stays
there. Nothing is uploaded anywhere else.

## 1. Install (once, about 5 minutes)

From the repo root, in PowerShell:

```powershell
py -3.12 -m venv helper\.venv
helper\.venv\Scripts\python -m pip install -r helper\requirements.txt
```

- `yt-dlp[default]` does the downloading.
- `deno` is the JavaScript runtime yt-dlp now needs for YouTube.
- `imageio-ffmpeg` brings an ffmpeg, which turns YouTube's audio into a plain
  m4a that iPhones can play.

`helper\.venv` is gitignored.

## 2. Run it

```powershell
helper\.venv\Scripts\python helper\songbook_helper.py
```

It prints `Songbook helper on http://127.0.0.1:8765`. Leave the window open
while you use it. It only listens on this PC; Tailscale (next step) is what
lets the phone in.

**Quick check on the PC:** open <http://127.0.0.1:8765/ping> in a browser. You
should see `{"ok": true, "yt_dlp": "…", "helper": "songbook"}`.

When the app runs locally (<http://localhost:8320>), it can use
`http://127.0.0.1:8765` directly: enter that under Settings → PC helper.

**Keep yt-dlp up to date.** YouTube changes often, and an old yt-dlp is the
usual reason downloads fail:

```powershell
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
   **Test**. It should say "Connected".

Nothing here opens a port on your router or Windows Firewall: the helper only
listens on 127.0.0.1, and Tailscale hands requests to it.

## 4. Use it

In a song's **Player**, paste a YouTube link (or use one the song already has,
like Late July's tutorial) and tap **Download**. The PC fetches the audio and
the phone keeps it as that song's recording. From then on it works like any
file: speed, **pitch** and fine tune, the waveform, loops, and **Analyse** for
chords.

**Late July:** the tutorial is played in open D♭. To learn it in open D, open
the song's Player, tap **Download** next to the tutorial, then raise **Pitch**
by **+1**. Speed down to taste: the pitch stays where you put it.

## Notes

- **Allowed callers.** Browsers may only call the helper from
  `https://linkel.github.io` (the deployed app, shared with speedy-pitcher) or
  `localhost`. Add another origin with `--allow-origin https://example.org`.
- **One download at a time.** That's plenty for one person and keeps YouTube calm.
- **Limits.** Files up to 200 MB.
- **Errors.** "Sign in to confirm you're not a bot" usually means yt-dlp needs
  updating (step 2), or YouTube is rate-limiting your IP for a while.
- **Start with Windows (optional).** In Task Scheduler, create a task "At log
  on" that runs `helper\.venv\Scripts\pythonw.exe helper\songbook_helper.py`
  with the repo folder as "Start in".

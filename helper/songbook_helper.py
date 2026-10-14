"""The Songbook's PC helper: fetch a video's audio with yt-dlp so the app can
slow it, loop it, pitch-shift it and analyse its chords like any other file.

Started from speedy-pitcher's helper/yt_helper.py (the owner's app). The
endpoints, port and CORS rules are the same, so speedy-pitcher can point at
this helper too. Later phases add analysis on the GPU (/analyze, /jobs).

Run it on a computer at home (a residential IP, which YouTube trusts far more
than cloud servers), then make it reachable from your phone over HTTPS with
Tailscale:  tailscale serve --bg 8765   (see helper/README.md)

    pip install -r helper/requirements.txt
    python helper/songbook_helper.py

Endpoints:
    GET /ping                -> {"ok": true, "yt_dlp": "<version>", "helper": "songbook"}
    GET /audio?url=<link>    -> the audio file (m4a when available)
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yt_dlp

try:  # the "deno" pip package ships the JS runtime yt-dlp needs for YouTube
    import deno

    os.environ["PATH"] = os.path.dirname(deno.find_deno_bin()) + os.pathsep + os.environ["PATH"]
except Exception:
    pass

# YouTube serves DASH-fragmented m4a, which Safari may refuse to decode; with
# ffmpeg available yt-dlp remuxes it into a plain m4a. imageio-ffmpeg is an
# easy pip-installable copy; an ffmpeg already on PATH works too.
try:
    import imageio_ffmpeg

    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    FFMPEG = shutil.which("ffmpeg")

MAX_BYTES = 200 * 1024 * 1024
DEFAULT_ORIGINS = ["https://linkel.github.io"]

# One download at a time is plenty for one person, and keeps YouTube happy.
download_lock = threading.Lock()


def fetch_audio(url, workdir):
    opts = {
        "format": "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best",
        "outtmpl": os.path.join(workdir, "%(id)s.%(ext)s"),
        "noplaylist": True,
        "max_filesize": MAX_BYTES,
        "quiet": True,
        "no_warnings": False,
    }
    if FFMPEG:
        opts["ffmpeg_location"] = FFMPEG
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        path = info["requested_downloads"][0]["filepath"]
    return path, info


class Handler(BaseHTTPRequestHandler):
    server_version = "SongbookHelper/1"

    def cors(self):
        origin = self.headers.get("Origin")
        if origin and (origin in self.server.origins or "*" in self.server.origins
                       or urllib.parse.urlparse(origin).hostname in ("localhost", "127.0.0.1")):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "X-Title, X-Duration, X-Source-Id")

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == "/ping":
            return self.send_json(200, {"ok": True, "yt_dlp": yt_dlp.version.__version__, "helper": "songbook"})
        if u.path != "/audio":
            return self.send_json(404, {"error": "not found"})
        url = (q.get("url") or [""])[0]
        if not url.startswith(("https://", "http://")):
            return self.send_json(400, {"error": "Pass ?url=<video link>"})

        workdir = tempfile.mkdtemp(prefix="songbook-")
        try:
            with download_lock:
                path, info = fetch_audio(url, workdir)
            size = os.path.getsize(path)
            ext = os.path.splitext(path)[1].lower()
            ctype = {".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm",
                     ".mp3": "audio/mpeg", ".opus": "audio/ogg"}.get(ext, "application/octet-stream")
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("X-Title", urllib.parse.quote(info.get("title") or "Untitled"))
            self.send_header("X-Duration", str(info.get("duration") or ""))
            self.send_header("X-Source-Id", urllib.parse.quote(info.get("id") or ""))
            self.end_headers()
            with open(path, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
        except yt_dlp.utils.DownloadError as e:
            msg = str(e).replace("\x1b[0;31mERROR:\x1b[0m ", "").replace("ERROR: ", "")
            self.send_json(502, {"error": msg})
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1", help="interface to listen on (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--allow-origin", action="append", default=[],
                   help="extra origin allowed to call the helper (repeatable; '*' allows any)")
    a = p.parse_args()
    server = ThreadingHTTPServer((a.host, a.port), Handler)
    server.origins = DEFAULT_ORIGINS + a.allow_origin
    print(f"Songbook helper on http://{a.host}:{a.port}  (yt-dlp {yt_dlp.version.__version__})")
    print("Allowed origins:", ", ".join(server.origins), "+ localhost")
    if not FFMPEG:
        print("Note: no ffmpeg found; iPhones may not decode YouTube's DASH m4a. pip install imageio-ffmpeg")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())

"""The Songbook's PC helper: fetch a video's audio with yt-dlp so the app can
slow it, loop it, pitch-shift it and analyse its chords like any other file,
and (Phase 5a) analyse recordings on the PC's GPU: stems, beats, chords,
sections and lyric timing, returned as a bundle the app imports.

Started from speedy-pitcher's helper/yt_helper.py (the owner's app). The
download endpoints, port and CORS rules are the same, so speedy-pitcher can
point at this helper too.

Run it on a computer at home (a residential IP, which YouTube trusts far more
than cloud servers), then make it reachable from your phone over HTTPS with
Tailscale:  tailscale serve --bg 8765   (see helper/README.md)

    python helper/songbook_helper.py              (in WSL2 Ubuntu for analysis)

Endpoints:
    GET  /ping                 -> {"ok": true, "yt_dlp": "<version>", "helper": "songbook", "analysis": {...}}
    GET  /audio?url=<link>     -> the audio file (m4a when available)
    POST /analyze[?url=<link>] -> {"id": ...}: queue an analysis. multipart/form-data fields:
                                  file (the audio, unless ?url= or job=), song, title, artist, name,
                                  lyrics (JSON [{index, text}]), lang, parts=guitar (with tuning,
                                  capo), job=<id> (with parts=guitar: just the part, on that job's bundle)
    GET  /jobs                 -> recent jobs
    GET  /jobs/<id>            -> {"state": "queued|running|done|failed|cancelled", "step", "progress", ...}
    POST /jobs/<id>/cancel
    GET  /bundle/<id>.zip      -> the result (also kept in private/songs/<slug>/ and <slug>.zip)
"""

import argparse
import json
import os
import queue
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
from email.parser import BytesParser
from email.policy import HTTP
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

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLES = os.path.join(os.path.dirname(HERE), "private", "songs")
MAX_BYTES = 200 * 1024 * 1024
DEFAULT_ORIGINS = ["https://linkel.github.io"]
HELPER_VERSION = 2

# One download at a time is plenty for one person, and keeps YouTube happy.
download_lock = threading.Lock()

# Analysis needs the GPU environment (requirements-gpu.txt); without it the
# helper still downloads.
try:
    import analysis
    analysis.check()
    ANALYSIS_ERROR = None
except Exception as e:  # pragma: no cover - depends on the machine
    analysis = None
    ANALYSIS_ERROR = f"{type(e).__name__}: {e}"


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


def dl_error(e):
    return str(e).replace("\x1b[0;31mERROR:\x1b[0m ", "").replace("ERROR: ", "")


# ---------------------------------------------------------------- jobs

def slugify(s):
    s = re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")
    return s[:60] or "song"


class Jobs:
    """A queue of analyses, one at a time on the GPU. Finished bundles stay
    in private/songs/, so they can be fetched again after a restart."""

    def __init__(self, root):
        self.root = root
        self.jobs = {}
        self.order = []
        self.lock = threading.Lock()
        self.q = queue.Queue()
        self.models = None
        os.makedirs(root, exist_ok=True)
        self.load_finished()
        threading.Thread(target=self.worker, daemon=True).start()

    def load_finished(self):
        for slug in sorted(os.listdir(self.root)):
            p = os.path.join(self.root, slug, "bundle.json")
            if not os.path.isfile(p):
                continue
            try:
                with open(p) as f:
                    m = json.load(f)
            except Exception:
                continue
            jid = m.get("job")
            z = os.path.join(self.root, slug + ".zip")
            if jid and os.path.isfile(z):
                self.jobs[jid] = {"id": jid, "state": "done", "slug": slug, "zip": z, "song": m.get("songId"), "title": m.get("title"),
                                  "artist": m.get("artist"), "created": m.get("created"), "progress": 1, "step": "bundle",
                                  "manifest": m, "bundle": f"/bundle/{jid}.zip"}
                self.order.append(jid)

    def add(self, opts, audio_path=None, url=None):
        jid = time.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(3).hex()
        steps = ([("download", "Downloading the link")] if url else []) + [(k, label) for k, label, _ in analysis.STEPS]
        if not opts.get("lyrics"):
            steps = [s for s in steps if s[0] != "lyrics"]
        if opts.get("parts") != "guitar":
            steps = [s for s in steps if s[0] != "parts"]
        if opts.get("job"):
            steps = [("parts", "Guitar part (basic-pitch)")]
        job = {"id": jid, "state": "queued", "step": None, "progress": 0, "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "song": opts.get("song"), "title": opts.get("title"), "artist": opts.get("artist"), "name": opts.get("name"),
               "url": url, "steps": [{"key": k, "label": label, "p": 0} for k, label in steps], "error": None,
               "_opts": opts, "_audio": audio_path, "_cancel": False}
        with self.lock:
            self.jobs[jid] = job
            self.order.append(jid)
            self.order = self.order[-200:]
        self.q.put(jid)
        return job

    def public(self, job):
        out = {k: v for k, v in job.items() if not k.startswith("_") and k != "zip"}
        out["queue"] = sum(1 for j in self.jobs.values() if j["state"] == "queued" and j["created"] < job["created"])
        return out

    def get(self, jid):
        return self.jobs.get(jid)

    def list(self):
        return [self.public(self.jobs[j]) for j in reversed(self.order) if j in self.jobs][:50]

    def cancel(self, jid):
        job = self.jobs.get(jid)
        if job and job["state"] in ("queued", "running"):
            job["_cancel"] = True
            if job["state"] == "queued":
                job["state"] = "cancelled"
        return job

    def set_step(self, job, key, p):
        job["step"] = key
        weights = {k: w for k, _, w in analysis.STEPS}
        weights["download"] = 0.15
        total = sum(weights.get(s["key"], 0.1) for s in job["steps"])
        acc = 0
        for s in job["steps"]:
            if s["key"] == key:
                s["p"] = round(max(s["p"], p), 3)
            acc += weights.get(s["key"], 0.1) * s["p"]
        job["progress"] = round(acc / total, 3)

    def worker(self):
        while True:
            jid = self.q.get()
            job = self.jobs.get(jid)
            if not job or job["state"] == "cancelled":
                continue
            job["state"] = "running"
            job["started"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            work = tempfile.mkdtemp(prefix="songbook-job-")
            try:
                opts = dict(job["_opts"])
                src = job["_audio"]
                if opts.get("job"):
                    # Just the guitar part, on an earlier job's bundle.
                    base = self.jobs.get(opts["job"])
                    if not base or base.get("state") != "done":
                        raise RuntimeError("That analysis isn't on the PC any more; analyse the recording again.")
                    out = os.path.join(self.root, base["slug"])
                    manifest = analysis.parts_only(out, opts, progress=lambda k, p: self.set_step(job, k, p))
                    manifest = {**manifest, "job": jid, "partsOnly": True, "files": ["part.json"] if manifest.get("part") else []}
                    z = os.path.join(self.root, base["slug"] + "-part.zip")
                    tmpdir = os.path.join(work, "p")
                    os.makedirs(tmpdir)
                    with open(os.path.join(tmpdir, "bundle.json"), "w") as f:
                        json.dump(manifest, f, indent=1)
                    if manifest["files"]:
                        shutil.copy(os.path.join(out, "part.json"), os.path.join(tmpdir, "part.json"))
                    analysis.zip_bundle(tmpdir, z)
                    job.update({"state": "done", "slug": base["slug"], "zip": z, "manifest": manifest, "bundle": f"/bundle/{jid}.zip", "progress": 1,
                                "finished": time.strftime("%Y-%m-%dT%H:%M:%S")})
                    continue
                if job["url"]:
                    self.set_step(job, "download", 0)
                    with download_lock:
                        src, info = fetch_audio(job["url"], work)
                    opts.setdefault("name", (info.get("title") or "Download") + os.path.splitext(src)[1])
                    opts["link"] = job["url"]
                    opts["keep_audio"] = True
                    job["name"] = opts["name"]
                    self.set_step(job, "download", 1)
                if self.models is None:
                    self.models = analysis.Models()
                slug = slugify(opts.get("title") and f"{opts.get('title')}-{opts.get('artist') or ''}" or opts.get("song"))
                out = os.path.join(self.root, slug)
                tmp_out = os.path.join(work, "bundle")
                manifest = analysis.analyse(src, tmp_out, opts, self.models,
                                            progress=lambda k, p: self.set_step(job, k, p),
                                            cancelled=lambda: job["_cancel"])
                manifest["job"] = jid
                with open(os.path.join(tmp_out, "bundle.json"), "w") as f:
                    json.dump(manifest, f, indent=1)
                shutil.rmtree(out, ignore_errors=True)
                shutil.move(tmp_out, out)
                z = analysis.zip_bundle(out, os.path.join(self.root, slug + ".zip"))
                job.update({"state": "done", "slug": slug, "zip": z, "manifest": manifest, "bundle": f"/bundle/{jid}.zip", "progress": 1,
                            "finished": time.strftime("%Y-%m-%dT%H:%M:%S")})
                analysis.log("done", jid, slug, manifest.get("seconds"), "s")
            except analysis.Cancelled:
                job["state"] = "cancelled"
            except yt_dlp.utils.DownloadError as e:
                job.update({"state": "failed", "error": dl_error(e)})
            except Exception as e:
                traceback.print_exc()
                job.update({"state": "failed", "error": str(e) or type(e).__name__})
            finally:
                shutil.rmtree(work, ignore_errors=True)
                if job.get("_audio") and os.path.exists(job["_audio"]):
                    try:
                        os.remove(job["_audio"])
                    except OSError:
                        pass
                    shutil.rmtree(os.path.dirname(job["_audio"]), ignore_errors=True)


def analysis_status():
    if analysis is None:
        return {"available": False, "reason": "Analysis isn't installed here: " + str(ANALYSIS_ERROR) + ". See helper/README.md (WSL2 Ubuntu)."}
    out = {"available": True}
    try:
        import torch
        out["gpu"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:
        out["gpu"] = None
    return out


def parse_multipart(ctype, body):
    """multipart/form-data -> {name: str or (filename, bytes)}."""
    msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body)
    out = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        data = part.get_payload(decode=True) or b""
        fn = part.get_filename()
        out[name] = (fn, data) if fn is not None else data.decode("utf-8", "replace")
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "SongbookHelper/2"

    def log_message(self, fmt, *args):
        if "/jobs/" in self.path and self.command == "GET":
            return  # the app polls these every couple of seconds
        super().log_message(fmt, *args)

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
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype):
        size = os.path.getsize(path)
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/ping":
                return self.send_json(200, {"ok": True, "yt_dlp": yt_dlp.version.__version__, "helper": "songbook",
                                            "version": HELPER_VERSION, "analysis": analysis_status()})
            if u.path == "/audio":
                return self.audio((q.get("url") or [""])[0])
            if u.path == "/jobs":
                return self.send_json(200, {"jobs": self.server.jobs.list() if self.server.jobs else []})
            m = re.fullmatch(r"/jobs/([\w-]+)", u.path)
            if m:
                job = self.server.jobs and self.server.jobs.get(m.group(1))
                return self.send_json(200, self.server.jobs.public(job)) if job else self.send_json(404, {"error": "No such job."})
            m = re.fullmatch(r"/bundle/([\w-]+)\.zip", u.path)
            if m:
                job = self.server.jobs and self.server.jobs.get(m.group(1))
                if not job or job["state"] != "done" or not os.path.isfile(job.get("zip") or ""):
                    return self.send_json(404, {"error": "That bundle isn't ready (or was removed)."})
                return self.send_file(job["zip"], "application/zip")
            return self.send_json(404, {"error": "not found"})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        m = re.fullmatch(r"/jobs/([\w-]+)/cancel", u.path)
        if m:
            job = self.server.jobs and self.server.jobs.cancel(m.group(1))
            return self.send_json(200, self.server.jobs.public(job)) if job else self.send_json(404, {"error": "No such job."})
        if u.path != "/analyze":
            return self.send_json(404, {"error": "not found"})
        if not self.server.jobs:
            return self.send_json(503, {"error": analysis_status()["reason"]})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BYTES:
            return self.send_json(413, {"error": "That file is over 200 MB."})
        body = self.rfile.read(length) if length else b""
        ctype = self.headers.get("Content-Type") or ""
        fields = parse_multipart(ctype, body) if ctype.startswith("multipart/form-data") else {}
        for k, v in q.items():
            fields.setdefault(k, v[0])
        url = fields.get("url") if isinstance(fields.get("url"), str) else None
        lyrics = []
        if isinstance(fields.get("lyrics"), str) and fields["lyrics"].strip():
            try:
                lyrics = [{"index": int(x["index"]), "text": str(x["text"])} for x in json.loads(fields["lyrics"])]
            except Exception:
                return self.send_json(400, {"error": "lyrics should be JSON: [{index, text}]"})
        opts = {k: fields[k] for k in ("song", "title", "artist", "name", "lang", "parts", "tuning", "capo", "job") if isinstance(fields.get(k), str)}
        opts["lyrics"] = lyrics
        audio_path = None
        if opts.get("job"):
            if opts.get("parts") != "guitar":
                return self.send_json(400, {"error": "job= re-runs the guitar part: send parts=guitar too."})
        elif url:
            if not url.startswith(("https://", "http://")):
                return self.send_json(400, {"error": "Pass ?url=<link>"})
        else:
            f = fields.get("file")
            if not isinstance(f, tuple) or not f[1]:
                return self.send_json(400, {"error": "Send the audio as a 'file' field, or a ?url= link."})
            d = tempfile.mkdtemp(prefix="songbook-up-")
            ext = os.path.splitext(f[0] or "")[1][:8] or ".audio"
            audio_path = os.path.join(d, "upload" + ext)
            with open(audio_path, "wb") as out:
                out.write(f[1])
            opts.setdefault("name", f[0])
        job = self.server.jobs.add(opts, audio_path=audio_path, url=url)
        return self.send_json(202, self.server.jobs.public(job))

    def audio(self, url):
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
            self.send_json(502, {"error": dl_error(e)})
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
    p.add_argument("--bundles", default=BUNDLES, help="where analysis bundles go (default: private/songs in the repo)")
    a = p.parse_args()
    server = ThreadingHTTPServer((a.host, a.port), Handler)
    server.origins = DEFAULT_ORIGINS + a.allow_origin
    server.jobs = Jobs(a.bundles) if analysis else None
    print(f"Songbook helper on http://{a.host}:{a.port}  (yt-dlp {yt_dlp.version.__version__})")
    print("Allowed origins:", ", ".join(server.origins), "+ localhost")
    st = analysis_status()
    print("Analysis:", f"ready ({st.get('gpu') or 'CPU only'}); bundles in {a.bundles}" if st["available"] else st["reason"])
    if not FFMPEG:
        print("Note: no ffmpeg found; iPhones may not decode YouTube's DASH m4a. pip install imageio-ffmpeg")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())

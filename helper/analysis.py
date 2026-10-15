"""The Songbook's analysis on the PC's GPU (plan §8.2): stems, beats and bar
lines, chords, sections and lyric timing for one recording, written as a
bundle the app imports.

    Demucs htdemucs_6s     stems: vocals, drums, bass, guitar, piano, other
    beat_this (CPJKU)      beats and downbeats
    ChordMini (MIT)        large-vocabulary chords: the BTC model retrained by
                           ChordMini with pseudo-labels, on the stems minus vocals
    bass stem / register   slash chords (G/B) when the bass note is clearly the chord's third or fifth
    our own                key (Krumhansl / Temperley profiles), tuning, bars
                           (majority chord per half bar) and sections (bar
                           blocks that repeat, by chroma and timbre)
    stable-ts (Whisper)    your pasted lyrics lined up with the vocal stem
    parts.py               the guitar part (with parts=guitar): basic-pitch notes
                           on the guitar stem, strings and frets, inferred fingers

Every result is a draft: the chart says "detected" and names the detectors.
Runs in WSL2 Ubuntu (helper/README.md). Python 3.12; the model versions are in
requirements-gpu.txt. A quick check on one file:

    python helper/analysis.py song.mp3 --out /tmp/bundle [--lyrics lines.txt]
"""

import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

import numpy as np

SR = 44100
CHORDMINI = os.environ.get("SONGBOOK_CHORDMINI", os.path.expanduser("~/src/ChordMini-model"))
CHORD_CHECKPOINT = "checkpoints/btc_model_best.pth"   # BTC, ChordMini's continual-learning checkpoint
WHISPER = os.environ.get("SONGBOOK_WHISPER", "large-v3")
BUNDLE_VERSION = 1

STEPS = [
    ("prepare", "Reading the audio", 0.03),
    ("stems", "Stems (Demucs)", 0.35),
    ("beats", "Beats and bar lines", 0.1),
    ("chords", "Chords (ChordMini)", 0.15),
    ("sections", "Key and sections", 0.07),
    ("parts", "Guitar part (basic-pitch)", 0.12),
    ("band", "Bass, melody and drums for the band", 0.05),
    ("lyrics", "Lining up your lyrics", 0.2),
    ("bundle", "Packing the bundle", 0.1),
]

STEM_LABELS = {"vocals": "Vocals", "drums": "Drums", "bass": "Bass", "guitar": "Guitar", "piano": "Piano", "other": "Other"}
STEM_ORDER = ["vocals", "guitar", "bass", "drums", "piano", "other"]

# ChordMini's 170-class vocabulary: index = root * 14 + quality; 168 X, 169 N.
QUALITIES = ["min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4"]
APP_QUALITY = {"min": "m", "maj": "", "dim": "dim", "aug": "aug", "min6": "m6", "maj6": "6", "min7": "m7", "minmaj7": "mmaj7",
               "maj7": "maj7", "7": "7", "dim7": "dim7", "hdim7": "m7b5", "sus2": "sus2", "sus4": "sus4"}
QUALITY_IV = {"min": [0, 3, 7], "maj": [0, 4, 7], "dim": [0, 3, 6], "aug": [0, 4, 8], "min6": [0, 3, 7, 9], "maj6": [0, 4, 7, 9],
              "min7": [0, 3, 7, 10], "minmaj7": [0, 3, 7, 11], "maj7": [0, 4, 7, 11], "7": [0, 4, 7, 10], "dim7": [0, 3, 6, 9],
              "hdim7": [0, 3, 6, 10], "sus2": [0, 2, 7], "sus4": [0, 5, 7]}
NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def check():
    """Raise if this machine can't analyse: the GPU libraries or ChordMini are missing."""
    import torch, demucs, beat_this, librosa, soundfile  # noqa: F401
    if not os.path.isfile(os.path.join(CHORDMINI, CHORD_CHECKPOINT)):
        raise RuntimeError(f"ChordMini isn't at {CHORDMINI} (set SONGBOOK_CHORDMINI)")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------- audio

def ffmpeg():
    return shutil.which("ffmpeg") or "ffmpeg"


def decode(src, sr=SR, channels=2):
    """Any file ffmpeg reads -> float32 array (channels, n)."""
    p = subprocess.run([ffmpeg(), "-v", "error", "-i", src, "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-"],
                       capture_output=True)
    if p.returncode != 0:
        raise RuntimeError("Couldn't read the audio: " + p.stderr.decode(errors="replace").strip()[-300:])
    x = np.frombuffer(p.stdout, dtype=np.float32)
    return x.reshape(-1, channels).T.copy()


def encode_m4a(x, path, sr=SR, kbps=96):
    """(channels, n) float32 -> AAC in an .m4a. The mp4 edit list hides the
    encoder delay, so the stem lines up with the original sample for sample."""
    x = np.ascontiguousarray(np.clip(x, -1, 1).T.astype(np.float32))
    p = subprocess.run([ffmpeg(), "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", str(x.shape[1]), "-i", "-",
                        "-c:a", "aac", "-b:a", f"{kbps}k", "-movflags", "+faststart", path], input=x.tobytes(), capture_output=True)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg couldn't write " + os.path.basename(path) + ": " + p.stderr.decode(errors="replace")[-300:])


def rms_db(x):
    return 20 * math.log10(float(np.sqrt(np.mean(np.square(x)))) + 1e-9)


# ---------------------------------------------------------------- models (loaded once, kept on the GPU)

class Models:
    def __init__(self, device=None):
        import torch
        self.torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._sep = self._beats = self._chords = self._whisper = None

    def versions(self):
        out = {"device": self.device}
        for m in ["torch", "demucs", "beat_this", "stable_whisper", "librosa"]:
            try:
                mod = __import__(m)
                out[m] = getattr(mod, "__version__", "?")
            except Exception:
                out[m] = None
        out["chordmini"] = chordmini_commit()
        return out

    def separator(self, callback=None):
        if self._sep is None:
            from demucs.api import Separator
            log("loading Demucs htdemucs_6s")
            self._sep = Separator(model="htdemucs_6s", device=self.device, progress=False)
        self._sep.update_parameter(callback=callback)
        return self._sep

    def beat_tracker(self):
        if self._beats is None:
            from beat_this.inference import Audio2Beats
            log("loading beat_this")
            self._beats = Audio2Beats(checkpoint_path="final0", device=self.device, dbn=False)
        return self._beats

    def chord_model(self):
        if self._chords is None:
            log("loading ChordMini")
            if CHORDMINI not in sys.path:
                sys.path.insert(0, CHORDMINI)
            from src.models import load_model
            from src.utils import HParams
            from src.evaluation.utils.common import extract_norm_stats
            config = HParams.load(os.path.join(CHORDMINI, "config", "ChordMini.yaml"))
            ckpt = os.path.join(CHORDMINI, CHORD_CHECKPOINT)
            model, _, _ = load_model(ckpt, "BTC", config, self.torch.device(self.device), None)
            model.eval()
            mean, std = extract_norm_stats(ckpt)
            seq = self.torch.load(ckpt, map_location="cpu", weights_only=False).get("timestep") or 108
            self._chords = {"model": model, "mean": float(np.asarray(mean).mean()) if np.ndim(mean) else float(mean),
                            "std": float(np.asarray(std).mean()) if np.ndim(std) else float(std), "seq": int(seq), "config": config}
        return self._chords

    def whisper(self):
        if self._whisper is None:
            import stable_whisper
            log("loading Whisper", WHISPER)
            self._whisper = stable_whisper.load_model(WHISPER, device=self.device)
        return self._whisper


def chordmini_commit():
    try:
        return subprocess.run(["git", "-C", CHORDMINI, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or None
    except Exception:
        return None


# ---------------------------------------------------------------- steps

def separate(models, mix, progress):
    """mix (2, n) at 44.1k -> {name: (2, n)}; near-silent stems folded into "other"."""
    import torch

    def cb(d):
        try:
            progress(min(0.99, (d["segment_offset"] + d.get("segment_length", 0)) / max(1, d["audio_length"]) / max(1, d.get("models", 1))))
        except Exception:
            pass

    sep = models.separator(cb)
    _, stems = sep.separate_tensor(torch.from_numpy(mix), SR)
    stems = {k: v.cpu().numpy().astype(np.float32) for k, v in stems.items()}
    mix_db = rms_db(mix)
    kept = {}
    for name in STEM_ORDER:
        if name not in stems:
            continue
        x = stems[name]
        if name not in ("vocals", "bass", "drums", "other") and rms_db(x) < mix_db - 30:
            stems["other"] = stems["other"] + x   # a piano or guitar stem with nothing in it
            continue
        kept[name] = x
    kept["other"] = stems["other"]
    return kept


def track_beats(models, mono):
    beats, downbeats = models.beat_tracker()(mono, SR)
    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    return beats, downbeats


def tempo_from(beats):
    """bpm from the beat gaps near the median (beat_this times come in 20 ms
    frames, so one gap alone is coarse; their mean is not)."""
    gaps = np.diff(beats)
    gaps = gaps[(gaps > 0.2) & (gaps < 2)]
    if not len(gaps):
        return 0.0
    med = float(np.median(gaps))
    near = gaps[np.abs(gaps - med) < 0.15 * med]
    return 60 / float(near.mean() if len(near) else med)


def meter_from(beats, downbeats):
    """Beats per bar (3 or 4) and which beat is beat 1, from the downbeats."""
    if len(downbeats) < 2 or len(beats) < 4:
        return 4, 0
    idx = [int(np.argmin(np.abs(beats - d))) for d in downbeats]
    gaps = [b - a for a, b in zip(idx, idx[1:]) if b > a]
    counts = {g: gaps.count(g) for g in set(gaps)}
    bpb = max(counts, key=counts.get) if counts else 4
    if bpb not in (2, 3, 4, 6):
        bpb = 4
    if bpb == 2:
        bpb = 4
    if bpb == 6:
        bpb = 3
    # beat 1: the phase most downbeats agree with
    votes = {}
    for i in idx:
        votes[i % bpb] = votes.get(i % bpb, 0) + 1
    phase = max(votes, key=votes.get)
    return bpb, phase


def chord_frames(models, x22, progress):
    """Mono audio at 22.05 kHz -> (frame seconds, probabilities (frames, 170))."""
    import librosa
    torch = models.torch
    cm = models.chord_model()
    hop, bins, bpo = 2048, 144, 24
    cqt = librosa.cqt(x22, sr=22050, n_bins=bins, bins_per_octave=bpo, hop_length=hop, fmin=librosa.note_to_hz("C1"))
    feat = np.log(np.abs(cqt) + 1e-6).T.astype(np.float32)
    progress(0.4)
    n = feat.shape[0]
    seq = cm["seq"]
    # Windows overlapping by half, probabilities averaged.
    stride = seq // 2
    pad = (seq - (n - seq) % stride) % stride if n > seq else seq - n
    f = np.pad(feat, ((0, pad), (0, 0)))
    starts = list(range(0, f.shape[0] - seq + 1, stride)) or [0]
    acc = np.zeros((n, 170), np.float32)
    cnt = np.zeros(n, np.float32)
    model = cm["model"]
    with torch.no_grad():
        for b in range(0, len(starts), 32):
            batch = np.stack([f[s:s + seq] for s in starts[b:b + 32]])
            t = (torch.from_numpy(batch).to(models.device) - cm["mean"]) / (cm["std"] + 1e-8)
            out = model(t)
            logits = out[0] if isinstance(out, tuple) else out
            p = torch.softmax(logits, dim=-1).cpu().numpy()
            for k, s in enumerate(starts[b:b + 32]):
                m = max(0, min(seq, n - s))
                acc[s:s + m] += p[k, :m]
                cnt[s:s + m] += 1
    acc /= np.maximum(cnt, 1)[:, None]
    progress(0.9)
    return hop / 22050, acc


def label_of(idx):
    if idx >= 168:
        return None, None, None
    return idx // 14, QUALITIES[idx % 14], idx


def app_name(root, quality, bass=None):
    s = NAMES[root] + APP_QUALITY[quality]
    if bass is not None and bass != root:
        s += "/" + NAMES[bass]
    return s


def low_chroma(x, sr=SR):
    """Pitch-class energy of the bass register (E1 to B3), frame by frame (hop
    2048 at 22.05 kHz)."""
    import librosa
    y = librosa.resample(x, orig_sr=sr, target_sr=22050)
    c = np.abs(librosa.cqt(y, sr=22050, hop_length=2048, fmin=librosa.note_to_hz("E1"), n_bins=32, bins_per_octave=12))
    pcs = np.zeros((12, c.shape[1]), np.float32)
    for k in range(c.shape[0]):
        pcs[(4 + k) % 12] += c[k]
    return pcs


def clear_bass(pcs, a, b):
    """The pitch class that stands out in frames a..b: at least twice anything
    but its own neighbours (the constant-Q bins smear a semitone either side). Or None."""
    seg = pcs[:, a:b].sum(1)
    if float(seg.sum()) <= 0:
        return None
    pc = int(np.argmax(seg))
    rest = max(float(seg[k]) for k in range(12) if min((k - pc) % 12, (pc - k) % 12) > 1)
    return pc if float(seg[pc]) >= 2.0 * rest else None


def beat_chords(ticks, frame_sec, probs, bass=None, low=None):
    """Per beat: (app chord name or None, strength 0..1). A chord whose bass
    note is clearly its third or fifth is named as an inversion (G/B): the
    note from the bass stem, or (no clear one there: a guitar playing its own
    bass line) from the bass register of everything but the vocals."""
    out = []
    n = probs.shape[0]
    for t0, t1 in zip(ticks, ticks[1:]):
        a, b = int(t0 / frame_sec), max(int(t0 / frame_sec) + 1, int(math.ceil(t1 / frame_sec)))
        a, b = min(a, n - 1), min(b, n)
        p = probs[a:b].mean(0)
        idx = int(np.argmax(p))
        root, q, _ = label_of(idx)
        if root is None:
            out.append((None, float(p[idx])))
            continue
        pc = clear_bass(bass, a, b) if bass is not None else None
        if pc is None and low is not None:
            pc = clear_bass(low, a, b)
        tones = [(root + i) % 12 for i in QUALITY_IV[q]]
        slash = pc if pc is not None and pc != root and pc in tones[1:3] else None
        out.append((app_name(root, q, slash), float(p[idx])))
    return out


# Key profiles (major, minor), from C.
PROFILES = {
    "krumhansl": ([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
                  [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]),
    "temperley": ([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
                  [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]),
}


def keys_from(chroma_sum):
    out = {}
    v = np.asarray(chroma_sum, float)
    v = (v - v.mean()) / (v.std() + 1e-9)
    for name, (maj, mnr) in PROFILES.items():
        best = None
        for tonic in range(12):
            for scale, prof in (("major", maj), ("minor", mnr)):
                p = np.roll(np.asarray(prof, float), tonic)
                p = (p - p.mean()) / p.std()
                r = float(np.dot(v, p) / len(v))
                if best is None or r > best[0]:
                    best = (r, tonic, scale)
        out[name] = {"key": NAMES[best[1]], "scale": best[2], "strength": round(best[0], 3)}
    return out


def tuning_cents(x22):
    import librosa
    try:
        return round(float(librosa.estimate_tuning(y=x22, sr=22050)) * 100, 1)
    except Exception:
        return 0.0


def majority(items):
    w = {}
    total = 0.0
    for name, s in items:
        if not name:
            continue
        x = 0.25 + s
        w[name] = w.get(name, 0) + x
        total += x
    if not w:
        return None, 0.0
    best = max(w, key=w.get)
    return best, w[best] / total


WEAK = 0.45


def make_bars(ticks, labels, bpb, phase):
    """Beats -> bars like the app's js/detect.js makeBars: the majority chord per
    half bar (a toss-up half goes with the bar's chord), "?" when unsure."""
    bars = []

    def add(i0, i1):
        bs = labels[i0:i1]
        if not bs:
            return
        if len(bs) >= 4 and bpb % 2 == 0:
            whole, _ = majority(bs)
            half = len(bs) // 2

            def half_of(part):
                c, share = majority(part)
                if share < 0.6 and any(n == whole for n, _ in part):
                    return whole, share
                return c, share
            a, sa = half_of(bs[:half])
            b, sb = half_of(bs[half:])
            chords = [a] if (a == b or not b) else [b] if not a else [a, b]
            share = (sa + sb) / 2
        else:
            c, share = majority(bs)
            chords = [c]
        chords = [c for c in chords if c]
        strength = sum(s for _, s in bs) / len(bs)
        # No chord all bar (a break, drums and voice): an N.C. bar, so the bars
        # still run through the whole song.
        if not chords:
            chords, share = ["N.C."], 1.0
        bars.append({"t": round(ticks[i0], 3), "t1": round(ticks[min(i1, len(ticks) - 1)], 3), "n": len(bs), "beat": i0,
                     "chords": chords, "strength": round(strength, 3), "sure": bool(share >= 0.6 and strength >= WEAK)})

    if phase > 0:
        add(0, phase)
    for i in range(phase, len(labels), bpb):
        add(i, min(len(labels), i + bpb))
    return bars


def bar_features(bars, chroma, mfcc, frame_sec):
    """Per bar: chroma (12) and timbre (MFCC 2..13), each unit length."""
    feats = []
    for b in bars:
        a, e = int(b["t"] / frame_sec), max(int(b["t"] / frame_sec) + 1, int(b["t1"] / frame_sec))
        c = chroma[:, a:e].mean(1) if e > a else np.zeros(12)
        m = mfcc[1:13, a:e].mean(1) if e > a else np.zeros(12)
        c = c / (np.linalg.norm(c) + 1e-9)
        m = (m - m.mean()) / (np.linalg.norm(m - m.mean()) + 1e-9)
        feats.append((c, m))
    return feats


def find_sections(bars, feats, sim_min=0.8):
    """Blocks of 8 bars (then 4) that come back become Part A, B, C...: a block
    counts as the same part when most of its bars have the same chords (as
    triads) and it sounds alike (chroma and timbre). Bars between parts make
    their own sections. Returns segments [{label, bars: [i...]}] in song order."""
    n = len(bars)
    keys = [" ".join(triad(c) for c in b["chords"]) for b in bars]

    def sim(i, j):
        ci, mi = feats[i]
        cj, mj = feats[j]
        sound = 0.6 * float(np.dot(ci, cj)) + 0.4 * (0.5 + 0.5 * float(np.dot(mi, mj)))
        return 0.6 * (1.0 if keys[i] == keys[j] else 0.0) + 0.4 * sound

    def block_sim(i, j, L):
        if i + L > n or j + L > n:
            return 0.0
        return sum(sim(i + k, j + k) for k in range(L)) / L

    labels = []        # [(label, start, L)]
    segs = []
    loose = []
    letter = 0
    i = 0

    def flush():
        nonlocal loose
        if loose:
            segs.append({"label": None, "bars": loose})
            loose = []

    while i < n:
        took = False
        for L in (8, 4):
            if i + L > n:
                continue
            # A block heard before?
            best = None
            for lab, s0, l0 in labels:
                if l0 == L:
                    v = block_sim(i, s0, L)
                    if v >= sim_min and (best is None or v > best[0]):
                        best = (v, lab)
            if best is None:
                # ...or one that comes back later.
                again = any(block_sim(i, j, L) >= sim_min for j in range(i + L, n - L + 1))
                if again:
                    best = (1, chr(65 + letter))
                    letter += 1
            if best:
                flush()
                labels.append((best[1], i, L))
                segs.append({"label": best[1], "bars": list(range(i, i + L))})
                i += L
                took = True
                break
        if not took:
            loose.append(i)
            i += 1
    flush()
    return segs


def triad(name):
    """"Bm7/F#" -> "Bm": the chord as a plain triad, for comparing bars."""
    m = re.match(r"^([A-G][#b]?)(m(?!aj)|dim|aug)?", name or "")
    return (m.group(1) + (m.group(2) or "")) if m else ""


def sections_from(bars, segs):
    """Segments -> chart sections and form. A part whose chords differ on a
    repeat gets its own numbered section."""
    sections, form = [], []
    links = 0
    for k, sg in enumerate(segs):
        chords = " | ".join(" ".join(bars[i]["chords"]) for i in sg["bars"])
        if sg["label"]:
            base = "Part " + sg["label"]
        elif k == 0:
            base = "Start"
        elif k == len(segs) - 1:
            base = "End"
        else:
            links += 1
            base = f"Link {links}"
        name = base
        same = [s for s in sections if s["name"] == base or s["name"].startswith(base + " (")]
        match = next((s for s in same if s["chords"] == chords), None)
        if match:
            name = match["name"]
        elif same:
            name = f"{base} ({len(same) + 1})"
        if not match:
            sections.append({"name": name, "chords": chords})
        sg["name"] = name
        form.append(name)
    return sections, form


def guess_key_name(keys, profile="temperley"):
    k = keys.get(profile)
    return k["key"] + ("m" if k["scale"] == "minor" else "") if k else None


# ---------------------------------------------------------------- lyrics

def align_lyrics(models, vocals, lines, lang="en"):
    """Pasted lyric lines [{index, text}] + the vocal stem -> [{index, t}]."""
    import soundfile as sf
    lines = [l for l in lines if str(l.get("text", "")).strip()]
    if not lines:
        return []
    text = "\n".join(re.sub(r"\s+", " ", str(l["text"])).strip() for l in lines)
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "vocals.wav")
        sf.write(p, vocals.mean(0), SR)
        # vad: words start where the singing does, not at the end of the silence before them.
        result = models.whisper().align(p, text, language=lang, original_split=True, vad=True, verbose=None)
    # original_split keeps one segment per line; each line starts at its first
    # word. A first word stretched over a long gap starts at most 1 s before it ends.
    def start(w):
        return round(max(float(w.start), float(w.end) - 1.0), 2)
    segs = [sg for sg in result.segments if sg.words]
    out = []
    if len(segs) == len(lines):
        for l, sg in zip(lines, segs):
            out.append({"index": int(l["index"]), "t": start(sg.words[0])})
    else:
        # Lines merged or split: walk the words, matching each line's letters.
        words = [w for sg in segs for w in sg.words]
        wi = 0
        for l in lines:
            if wi >= len(words):
                break
            out.append({"index": int(l["index"]), "t": start(words[wi])})
            target = re.sub(r"[^\w]", "", str(l["text"]).lower())
            got = ""
            while wi < len(words) and len(got) < len(target):
                got += re.sub(r"[^\w]", "", words[wi].word.lower())
                wi += 1
    # Times must not go backwards.
    for a, b in zip(out, out[1:]):
        if b["t"] < a["t"]:
            b["t"] = a["t"]
    return out


# ---------------------------------------------------------------- the whole job

def analyse(src, out_dir, opts, models, progress=lambda step, p: None, cancelled=lambda: False):
    """Analyse audio file `src` into bundle folder `out_dir`. opts: {song, title,
    artist, lyrics: [{index, text}], lang, keep_audio, link}. Returns the
    bundle manifest."""
    import librosa
    t_start = time.time()
    os.makedirs(os.path.join(out_dir, "stems"), exist_ok=True)
    timings = {}

    def step(name):
        if cancelled():
            raise Cancelled()
        timings[name] = time.time()
        progress(name, 0)

    def done(name):
        timings[name] = round(time.time() - timings[name], 2)
        progress(name, 1)

    step("prepare")
    mix = decode(src)
    duration = mix.shape[1] / SR
    if duration > 20 * 60:
        raise RuntimeError("That recording is over 20 minutes; analyse one song at a time.")
    mono = mix.mean(0)
    done("prepare")

    step("stems")
    stems = separate(models, mix, lambda p: progress("stems", p))
    done("stems")

    step("beats")
    beats, downbeats = track_beats(models, mono)
    if len(beats) < 8:
        raise RuntimeError("Couldn't find a steady beat in that recording.")
    bpb, phase = meter_from(beats, downbeats)
    bpm = tempo_from(beats)
    ticks = list(beats) + [float(beats[-1] + 60 / (bpm or 120))]
    done("beats")

    step("chords")
    accomp = sum(v for k, v in stems.items() if k != "vocals").mean(0)
    x22 = librosa.resample(accomp, orig_sr=SR, target_sr=22050)
    frame_sec, probs = chord_frames(models, x22, lambda p: progress("chords", p * 0.8))
    labels = beat_chords(ticks, frame_sec, probs, low_chroma(stems["bass"].mean(0)) if "bass" in stems else None, low_chroma(accomp))
    done("chords")

    step("sections")
    chroma = librosa.feature.chroma_cqt(y=x22, sr=22050, hop_length=2048)
    mfcc = librosa.feature.mfcc(y=librosa.resample(mono, orig_sr=SR, target_sr=22050), sr=22050, hop_length=2048, n_mfcc=13)
    keys = keys_from(chroma.sum(1))
    tuning = tuning_cents(x22)
    bars = make_bars(ticks, labels, bpb, phase)
    feats = bar_features(bars, chroma, mfcc, frame_sec)
    segs = find_sections(bars, feats) if bars else []
    sections, form = sections_from(bars, segs)
    done("sections")

    part_doc = None
    if opts.get("parts") == "guitar":
        step("parts")
        part_doc = guitar_part(stems, None, opts, sections=sections, form=form, segs=segs, bars=bars, bpb=bpb)
        done("parts")

    # The synth band's transcribed parts (arrange.py).
    step("band")
    try:
        import arrange
        arr = arrange.arrangement({k: librosa.resample(v.mean(0), orig_sr=SR, target_sr=arrange.SR) for k, v in stems.items()})
    except Exception as e:
        log("arrangement failed:", e)
        arr = None
    done("band")

    timing = []
    lyr = opts.get("lyrics") or []
    if lyr and "vocals" in stems:
        step("lyrics")
        try:
            timing = align_lyrics(models, stems["vocals"], lyr, opts.get("lang") or "en")
        except Exception as e:
            log("lyric alignment failed:", e)
            timing = []
        done("lyrics")

    step("bundle")
    v = models.versions()
    detector = (f"ChordMini BTC ({v.get('chordmini') or '?'}), beat_this {v.get('beat_this') or ''}, Demucs htdemucs_6s, "
                f"on the PC helper").replace("  ", " ")
    sure = sum(1 for b in bars if b["sure"]) / max(1, len(bars))
    chart = {
        "id": opts.get("song"), "title": opts.get("title"), "artist": opts.get("artist"), "type": "song",
        "key": guess_key_name(keys), "capo": 0, "time": "3/4" if bpb == 3 else "4/4", "tempo": round(bpm) if bpm else None,
        "style": None, "strum": None, "voicings": {},
        "sections": sections, "form": form,
        "source": "detected", "detector": detector, "confidence": "medium" if sure >= 0.85 else "low",
        "sources": [], "notes": "Detected from your recording on the PC: a draft. Check it by ear with Play along.",
        "beats": [round(float(t), 3) for t in ticks],
        "bars": [{"t": b["t"], "n": b["n"], "chords": b["chords"], "strength": b["strength"], "sure": b["sure"], "edited": False} for b in bars],
        "analysis": {
            "bpm": round(bpm, 2), "bpb": bpb, "phase": phase, "duration": round(duration, 3), "tuning": tuning,
            "keys": keys, "profile": "temperley", "file": opts.get("name"), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "ticks": [round(float(t), 3) for t in ticks], "factor": 1,
            "beatChords": [n or "N" for n, _ in labels], "beatStrength": [round(s, 3) for _, s in labels],
            "downbeats": [round(float(t), 3) for t in downbeats],
            "segments": [{"name": sg["name"], "bars": [sg["bars"][0], sg["bars"][-1]]} for sg in segs],
            "helper": {"detector": detector, "versions": v, "seconds": {k: x for k, x in timings.items() if k != "bundle"}},
            "version": "helper-" + str(BUNDLE_VERSION),
        },
    }
    if opts.get("link"):
        chart["links"] = [{"label": "Analysed from", "url": opts["link"]}]
    stem_list = []
    for name in STEM_ORDER:
        if name not in stems:
            continue
        fn = f"stems/{name}.m4a"
        encode_m4a(stems[name], os.path.join(out_dir, fn))
        stem_list.append({"name": name, "label": STEM_LABELS[name], "file": fn, "db": round(rms_db(stems[name]), 1)})
        progress("bundle", len(stem_list) / (len(stems) + 1))
    files = ["chart.json"] + [s["file"] for s in stem_list]
    if opts.get("keep_audio"):
        encode_m4a(mix, os.path.join(out_dir, "audio.m4a"), kbps=160)
        files.append("audio.m4a")
    with open(os.path.join(out_dir, "chart.json"), "w") as f:
        json.dump(chart, f, indent=1)
    if part_doc:
        with open(os.path.join(out_dir, "part.json"), "w") as f:
            json.dump(part_doc, f, indent=1)
        files.append("part.json")
    if arr and arr["tracks"]:
        with open(os.path.join(out_dir, "arrangement.json"), "w") as f:
            json.dump(arr, f)
        files.append("arrangement.json")
    if timing:
        with open(os.path.join(out_dir, "timing.json"), "w") as f:
            json.dump({"songId": opts.get("song"), "lines": timing, "source": "aligned",
                       "aligner": f"stable-ts {v.get('stable_whisper')} (Whisper {WHISPER}) on the vocal stem"}, f)
        files.append("timing.json")
    manifest = {
        "app": "songbook", "kind": "bundle", "version": BUNDLE_VERSION, "songId": opts.get("song"),
        "title": opts.get("title"), "artist": opts.get("artist"), "created": chart["analysis"]["at"],
        "source": {"name": opts.get("name"), "link": opts.get("link")}, "duration": round(duration, 3),
        "detector": detector, "stems": stem_list, "files": files, "timing": bool(timing), "part": bool(part_doc), "arrangement": bool(arr and arr["tracks"]),
        "audio": "audio.m4a" if opts.get("keep_audio") else None, "seconds": round(time.time() - t_start, 1),
    }
    with open(os.path.join(out_dir, "bundle.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    done("bundle")
    return manifest


PARTS_DETECTOR = "basic-pitch notes on the guitar stem, strings and frets by the Songbook's own pass (parts.py)"


def guitar_part(stems, chart, opts, sections=None, form=None, segs=None, bars=None, bpb=4):
    """The guitar part for each section (parts.py), as part.json's contents:
    { detector, tuning, capo, sections: { name: part } }, or None."""
    import parts as P
    if chart is None:
        chart = {"bars": [{"t": b["t"], "chords": b["chords"]} for b in bars], "sections": sections, "form": form,
                 "time": "3/4" if bpb == 3 else "4/4", "analysis": {"segments": [{"name": s["name"], "bars": [s["bars"][0], s["bars"][-1]]} for s in segs]}}
    # The guitar stem, unless it's nearly empty (then "other").
    g = stems.get("guitar")
    if g is None or rms_db(g) < rms_db(sum(stems.values())) - 30:
        g = stems.get("other")
    if g is None:
        return None
    try:
        capo = int(opts.get("capo") or 0)
    except ValueError:
        capo = 0
    found, stats = P.detect_parts(chart, g.mean(0), SR, opts.get("tuning") or None, capo)
    if not found:
        return None
    for p in found.values():
        p["detector"] = PARTS_DETECTOR
    notes = stats.pop("found", [])
    log("parts", stats)
    return {"detector": PARTS_DETECTOR, "tuning": opts.get("tuning") or "E A D G B E", "capo": capo, "sections": found, "stats": stats,
            "notes": notes}


def parts_only(bundle_dir, opts, progress=lambda step, p: None):
    """Re-run just the guitar part on an existing bundle (its stems and chart).
    Rewrites part.json and the manifest; returns the manifest."""
    progress("parts", 0)
    with open(os.path.join(bundle_dir, "chart.json")) as f:
        chart = json.load(f)
    with open(os.path.join(bundle_dir, "bundle.json")) as f:
        manifest = json.load(f)
    stems = {}
    for s in manifest.get("stems", []):
        if s["name"] in ("guitar", "other"):
            stems[s["name"]] = decode(os.path.join(bundle_dir, s["file"]))
    doc = guitar_part(stems, chart, opts)
    progress("parts", 0.9)
    if doc:
        with open(os.path.join(bundle_dir, "part.json"), "w") as f:
            json.dump(doc, f, indent=1)
        if "part.json" not in manifest["files"]:
            manifest["files"].append("part.json")
    manifest["part"] = bool(doc)
    with open(os.path.join(bundle_dir, "bundle.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    progress("parts", 1)
    return manifest


def zip_bundle(out_dir, zip_path, only=None):
    """Stored (uncompressed) zip: the app's js/zip.js reads it, and audio doesn't compress."""
    with open(os.path.join(out_dir, "bundle.json")) as f:
        manifest = json.load(f)
    tmp = zip_path + ".part"
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED) as z:
        z.write(os.path.join(out_dir, "bundle.json"), "bundle.json")
        for fn in only or manifest["files"]:
            z.write(os.path.join(out_dir, fn), fn)
    os.replace(tmp, zip_path)
    return zip_path


def main():
    import argparse
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("audio")
    p.add_argument("--out", required=True)
    p.add_argument("--lyrics", help="a text file, one lyric line per line")
    p.add_argument("--title", default="")
    p.add_argument("--artist", default="")
    a = p.parse_args()
    lyrics = []
    if a.lyrics:
        with open(a.lyrics) as f:
            lyrics = [{"index": i, "text": t.strip()} for i, t in enumerate(f) if t.strip()]
    models = Models()
    m = analyse(a.audio, a.out, {"song": "test", "title": a.title, "artist": a.artist, "lyrics": lyrics, "name": os.path.basename(a.audio)},
                models, progress=lambda s, x: log(s, round(x, 2)) if x in (0, 1) else None)
    zip_bundle(a.out, a.out.rstrip("/") + ".zip")
    print(json.dumps({k: m[k] for k in ("seconds", "stems", "files")}, indent=1))
    with open(os.path.join(a.out, "chart.json")) as f:
        c = json.load(f)
    print("key", c["key"], "tempo", c["tempo"], "time", c["time"], "bars", len(c["bars"]), "form", c["form"])
    for s in c["sections"]:
        print(" ", s["name"], ":", s["chords"])
    print(json.dumps(c["analysis"]["helper"]["seconds"]))


if __name__ == "__main__":
    main()

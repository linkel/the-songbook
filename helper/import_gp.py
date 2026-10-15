"""A Guitar Pro tab, lined up with your recording, in place of a bundle's
detected chart and part: the bars, chords and guitar part come from the tab;
the bar times from the recording.

    python helper/import_gp.py private/songs/<slug> <file.gp> [--from "where the tab is from"] [--url <link>]

then ship it as usual: node tools/ship-bundle.mjs private/songs/<slug>

1. The tab (gp.py): its bars, the notes in them, its tuning.
2. Lining up: the tab's notes, beat by beat, as pitch classes, against the
   recording's chroma (everything but the vocals and drums) between the beats
   the helper found, by dynamic time warping. A bar starts on the recording's
   beat its first beat lines up with. A live tab of the same performance lines
   up beat for beat; a studio tab against a live take won't.
3. Chords: what each bar's notes make (gp.bar_chords); a bar with no notes is N.C.
4. Sections: blocks of bars whose chords come back (find_blocks), the same
   section only when its chords and tab are the same; each section's part is
   its bars, written out.

The chart and part say where they came from (source "web", with --from and
--url). The bundle keeps the detected ones as chart.detected.json and
part.detected.json. Runs in the helper's venv (WSL).
"""

import argparse
import json
import os
import shutil
import sys
from fractions import Fraction as F

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analysis  # noqa: E402
import gp  # noqa: E402


def beat_chroma_tab(tab):
    """The tab's beats -> ([12-vectors], [first beat of each bar])."""
    open_ = tab["tuning"]
    out, starts = [], []
    flat = [(bi, n) for bi, b in enumerate(tab["bars"]) for n in b["notes"] if not n.get("drop") and not n["mute"]]
    for bi, b in enumerate(tab["bars"]):
        starts.append(len(out))
        beat = b["length"] / b["num"]
        for k in range(b["num"]):
            q0, q1 = beat * k, beat * (k + 1)
            v = np.zeros(12)
            for nb, n in flat:
                if nb > bi or nb < bi - 4:
                    continue
                # Onset and length in this bar's quarter notes.
                off = sum((tab["bars"][x]["length"] for x in range(nb, bi)), F(0))
                a, e = n["q"] - off, n["q"] - off + n["len"]
                ov = min(e, q1) - max(a, q0)
                if ov > 0:
                    # A note counts most where it's picked, less as it rings.
                    v[(open_[6 - n["string"]] + n["fret"]) % 12] += float(ov) * (2.0 if q0 <= a < q1 else 1.0)
            out.append(v)
    return np.array(out), starts


def even_beats(ticks, end=None):
    """The beat tracker's beats, evened out: a beat tracked at double speed
    (half the usual gap) is dropped, and a gap of two or more beats (a pause
    the tracker found nothing in) is filled at the usual spacing, and the
    beats go on to the end of the recording."""
    t = list(ticks)
    for _ in range(2):
        gaps = np.diff(t)
        med = [float(np.median(gaps[max(0, k - 8):k + 9])) for k in range(len(gaps))]
        out = [t[0]]
        for k in range(1, len(t)):
            g, m = t[k] - out[-1], med[k - 1]
            if g < 0.7 * m:
                continue
            n = int(round(g / m))
            step = g / n
            for _ in range(1, n):
                out.append(out[-1] + step)
            out.append(t[k])
        t = out
    # On to the end of the recording: the last chord can ring past the last beat found.
    m = float(np.median(np.diff(t[-16:])))
    while end and t[-1] + m < end - 0.5:
        t.append(t[-1] + m)
    return t


def beat_chroma_audio(bundle, chart):
    import librosa
    files = [os.path.join(bundle, s["file"]) for s in json.load(open(os.path.join(bundle, "bundle.json")))["stems"] if s["name"] not in ("vocals", "drums")]
    mix = sum(analysis.decode(f, sr=22050, channels=1)[0] for f in files)
    chroma = librosa.feature.chroma_cqt(y=mix, sr=22050, hop_length=512)
    fs = 512 / 22050
    ticks = even_beats(chart["analysis"]["ticks"], len(mix) / 22050)
    out = []
    for t0, t1 in zip(ticks, ticks[1:]):
        a, b = int(t0 / fs), max(int(t0 / fs) + 1, int(t1 / fs))
        out.append(chroma[:, a:b].mean(1))
    return np.array(out), ticks


def unit(m):
    n = np.linalg.norm(m, axis=1, keepdims=True)
    return np.where(n > 0, m / np.maximum(n, 1e-9), 0)


def align(tab_c, audio_c):
    """DTW over beats -> for each tab beat, the first recording beat it lines up with; and the mean similarity."""
    import librosa
    A, B = unit(tab_c), unit(audio_c)
    sim = A @ B.T
    empty = np.linalg.norm(tab_c, axis=1) == 0
    sim[empty, :] = 0.5                      # a rest fits anywhere
    D, wp = librosa.sequence.dtw(C=1 - sim, step_sizes_sigma=np.array([[1, 1], [0, 1], [1, 0]]), weights_mul=np.array([1, 1.5, 1.5]))
    wp = wp[::-1]
    first = {}
    for i, j in wp:
        first.setdefault(int(i), int(j))
    diag = sum(1 for (i0, j0), (i1, j1) in zip(wp, wp[1:]) if i1 - i0 == 1 and j1 - j0 == 1) / max(1, len(wp) - 1)
    score = float(np.mean([sim[i, j] for i, j in wp if not empty[i]]))
    return first, score, diag


def find_blocks(bars, max_len=16, sim_min=0.8):
    """The song's sections from the bars' chord roots: blocks that start and
    end where the chord changes, each one like another block somewhere else
    in the song, chosen by dynamic programming (a block's worth: its length
    times how alike its best match is; a block that never comes back costs).
    Repeated until the blocks match blocks that were chosen. Short leftovers
    join the block before. -> [[bar indexes]]."""
    import re
    tok = [(re.match(r"^[A-G][#b]?", b["chords"][0]) or re.match("N", "N")).group(0) for b in bars]
    n = len(tok)
    cp = [i == 0 or tok[i] != tok[i - 1] for i in range(n)] + [True]

    def sim(i, k, L):
        return sum(tok[i + x] == tok[k + x] for x in range(L)) / L if k + L <= n else 0

    def solve(starts):
        best = [(-1e9, None)] * (n + 1)
        best[0] = (0, None)
        for j in range(1, n + 1):
            if not cp[j]:
                continue
            for L in range(1, min(max_len, j) + 1):
                i = j - L
                if not cp[i] or (i and best[i][1] is None):
                    continue
                m = max([sim(i, k, L) for k in starts if abs(k - i) >= L and cp[min(n, k + L)]] or [0]) if L >= 4 else 0
                v = best[i][0] + (L * m if m >= sim_min else -0.3 * L) - 3
                if v > best[j][0]:
                    best[j] = (v, (i, m))
        out, j = [], n
        while j > 0:
            i, m = best[j][1]
            out.append((i, j, m))
            j = i
        return out[::-1]

    starts = [i for i in range(n) if cp[i]]
    for _ in range(8):
        segs = solve(starts)
        if [s[0] for s in segs] == starts:
            break
        starts = [s[0] for s in segs]
    blocks = []
    for i, j, m in segs:
        if blocks and m < sim_min and j - i <= 4 and len(blocks[-1]) + j - i <= max_len and j < n:
            blocks[-1].extend(range(i, j))
        else:
            blocks.append(list(range(i, j)))
    return blocks, tok


def onset_curve(bundle):
    """The recording's note onsets (guitar and other stems): (strength per
    frame, scaled 0..1, frame seconds)."""
    import librosa
    files = [os.path.join(bundle, s["file"]) for s in json.load(open(os.path.join(bundle, "bundle.json")))["stems"] if s["name"] in ("guitar", "other")]
    x = sum(analysis.decode(f, sr=22050, channels=1)[0] for f in files)
    env = librosa.onset.onset_strength(y=x, sr=22050, hop_length=256)
    env = env / (np.percentile(env, 99) + 1e-9)
    return np.clip(env, 0, 1), 256 / 22050


def refine(js, tab, ticks, env, fs):
    """Each bar's first beat, nudged a beat either way where the tab's notes
    then land on the recording's onsets better (DTW on pitch alone can slip a
    beat in held chords and rests). js: recording beat per bar, changed in place.
    -> how many bars moved."""
    bars = tab["bars"]
    end_j = len(ticks) - 1

    def fit(i, j0, j1):
        if j1 <= j0:
            return -9
        t0, t1 = ticks[j0], ticks[min(j1, end_j)]
        qs = sorted({n["q"] for n in bars[i]["notes"] if not n.get("drop")})
        if not qs:
            return 0.3 - 0.15 * abs(j1 - j0 - bars[i]["num"])
        hits = []
        for q in qs:
            f = int((t0 + (t1 - t0) * float(q / bars[i]["length"])) / fs)
            hits.append(env[max(0, f - 2):f + 3].max() if f < len(env) else 0)
        return float(np.mean(hits)) - 0.15 * abs(j1 - j0 - bars[i]["num"])

    moved = set()
    for _ in range(4):
        changed = False
        for i in range(len(js)):
            nxt = js[i + 1] if i + 1 < len(js) else min(end_j, js[i] + bars[i]["num"])
            prev = js[i - 1] if i else None
            best = None
            for d in (-1, 0, 1):
                j = js[i] + d
                if j < 0 or j > end_j or (prev is not None and j <= prev) or j >= nxt:
                    continue
                v = fit(i, j, nxt) + (fit(i - 1, prev, j) if prev is not None else 0)
                if best is None or v > best[0] + 1e-9:
                    best = (v, j)
            if best and best[1] != js[i]:
                js[i] = best[1]
                moved.add(i)
                changed = True
        if not changed:
            break
    return len(moved)


def sections_for(bars, steps):
    """Blocks -> sections and form: blocks alike get the same letter; a repeat
    is the same section only when its chords and tab are the same, else it's
    numbered (Part A (2))."""
    blocks, tok = find_blocks(bars)
    letters = []          # [(letter, tokens)]
    segs = []
    for k, bl in enumerate(blocks):
        t = [tok[i] for i in bl]
        lab = next((l for l, u in letters if len(u) == len(t) and sum(a == b for a, b in zip(u, t)) / len(t) >= 0.8), None)
        again = any(len(o) == len(bl) and sum(tok[a] == tok[b] for a, b in zip(bl, o)) / len(bl) >= 0.8 for o in blocks if o is not bl)
        if lab is None and again:
            lab = chr(65 + len(letters))
            letters.append((lab, t))
        segs.append({"label": lab, "bars": bl})
    sections, form, links = [], [], 0
    for k, sg in enumerate(segs):
        chords = " | ".join(" ".join(bars[i]["chords"]) for i in sg["bars"])
        tab = [steps[i] for i in sg["bars"]]
        if sg["label"]:
            base = "Part " + sg["label"]
        elif k == 0:
            base = "Start"
        elif k == len(segs) - 1:
            base = "End"
        else:
            links += 1
            base = f"Link {links}"
        same = [s for s in sections if s["name"] == base or s["name"].startswith(base + " (")]
        match = next((s for s in same if s["chords"] == chords and s["_tab"] == tab), None)
        name = match["name"] if match else base if not same else f"{base} ({len(same) + 1})"
        if not match:
            sections.append({"name": name, "chords": chords, "_tab": tab, "_bars": sg["bars"]})
        sg["name"] = name
        form.append(name)
    return sections, form, segs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle")
    ap.add_argument("gp")
    ap.add_argument("--from", dest="src", default=None, help="where the tab is from, e.g. Songsterr")
    ap.add_argument("--url", default=None)
    a = ap.parse_args()
    bundle = a.bundle.rstrip("/")
    chart_path, part_path = os.path.join(bundle, "chart.json"), os.path.join(bundle, "part.json")
    keep = os.path.join(bundle, "chart.detected.json")
    if not os.path.exists(keep):
        shutil.copy(chart_path, keep)
        if os.path.exists(part_path):
            shutil.copy(part_path, os.path.join(bundle, "part.detected.json"))
    detected = json.load(open(keep, encoding="utf-8"))

    tab = gp.read_gp(a.gp)
    open_ = tab["tuning"]
    tab_c, starts = beat_chroma_tab(tab)
    audio_c, ticks = beat_chroma_audio(bundle, detected)
    first, score, diag = align(tab_c, audio_c)
    print(f"lined up {len(tab_c)} tab beats with {len(audio_c)} recording beats: similarity {score:.2f}, {diag:.0%} beat for beat")

    js = [first[starts[bi]] for bi in range(len(tab["bars"]))]
    env, fs = onset_curve(bundle)
    moved = refine(js, tab, ticks, env, fs)
    off = [js[i + 1] - js[i] - tab["bars"][i]["num"] for i in range(len(js) - 1)]
    print(f"{moved} bars moved a beat to fit the onsets; bars not their tab length in the recording's beats: {[(i, d) for i, d in enumerate(off) if d]}")
    bars, steps, rounded, quiet = [], [], 0, []
    for bi, b in enumerate(tab["bars"]):
        t = ticks[js[bi]]
        st, _, exact = gp.bar_steps(b)
        rounded += not exact
        chords, fit = gp.bar_chords(b, open_)
        bars.append({"t": round(t, 3), "n": b["num"], "chords": chords or ["N.C."], "sure": fit >= 0.75 or not chords, "_fit": fit})
        steps.append(st)
    # Bars past the end of the recording all line up with its last beats: drop them.
    while len(bars) > 1 and bars[-1]["t"] <= bars[-2]["t"]:
        bars.pop()
        steps.pop()
        quiet.append(len(bars))
    sections, form, segs = sections_for(bars, steps)

    who = a.src or (tab["tabber"] or "a tab").replace(" Downloader", "")
    title = tab["title"] or os.path.basename(a.gp)
    cite = f"{who}: {title}, from your Guitar Pro file {os.path.basename(a.gp)}"
    chart = dict(detected)
    chart.update({
        "time": f"{tab['bars'][0]['num']}/{tab['bars'][0]['den']}" if all(b["num"] == tab["bars"][0]["num"] for b in tab["bars"]) else "4/4",
        "sections": [{"name": s["name"], "chords": s["chords"]} for s in sections], "form": form,
        "source": "web", "detector": None, "confidence": "medium",
        "sources": [{"label": cite, "url": a.url}] if a.url else [{"label": cite}],
        "notes": f"The chords, bars and guitar part are from the tab ({cite}); the chord names are worked out from its notes. "
                 f"The bar times come from your recording, lined up with the tab beat by beat.",
        "bars": [{k: v for k, v in b.items() if not k.startswith("_")} for b in bars],
    })
    chart["analysis"] = dict(detected["analysis"], segments=[{"name": sg["name"], "bars": [sg["bars"][0], sg["bars"][-1]]} for sg in segs],
                             tab={"file": os.path.basename(a.gp), "similarity": round(score, 3), "diagonal": round(diag, 3)})
    chart.pop("checkedFrom", None)
    parts = {}
    for s in sections:
        pb, prev = [], None
        for i in s["_bars"]:
            pb.append({} if steps[i] == prev else {"steps": steps[i]})
            prev = steps[i]
        parts[s["name"]] = {"source": "web", "from": cite, **({"url": a.url} if a.url else {}), "fingers": "inferred", "bars": pb}
    tuning = " ".join(analysis_note(m) for m in open_)
    json.dump(chart, open(chart_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    json.dump({"detector": None, "from": cite, "tuning": tuning, "capo": tab["capo"], "sections": parts}, open(part_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    st = tab["stats"]
    print(f"{len(bars)} bars ({len(quiet)} past the recording's end dropped), {len(sections)} sections, form {len(form)}; "
          f"{rounded} bars with 32nd notes rounded to 16ths; kept without their bend: {st['bends']}, palm muting: {st['palm']}")
    for s in sections:
        print(f"  {s['name']}: {s['chords']}")


def analysis_note(m):
    return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][m % 12]


if __name__ == "__main__":
    main()

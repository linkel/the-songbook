"""Guitar Pro files (GP7/GP8 `.gp`, or the `score.gpif` inside one) as the
app's parts: a tab someone wrote, bar by bar, for when the detector's part
isn't right. import_gp.py lines it up with your recording.

    read_gp(path)            -> the first guitar track: tuning, capo, bars of
                                notes (onset and length in quarter notes,
                                string 1..6 high to low, fret, technique)
    bar_steps(bar)           -> the bar in the step notation (js/patterns.js):
                                8, 12 or 16 steps (more for fast triplets),
                                every note with its exact string and @fret
    bar_chords(bar, open_)   -> the chord(s) the bar's notes make, by template

Hammer-ons, pull-offs and slides into the next note on the string become
h / o / "/" "\\" on the first note; a tied note isn't picked again; dead notes
are x. Bends and palm muting have no notation in the app: the note is kept,
and they're counted. The picking fingers aren't in a tab: they're inferred
(parts.fingers_for: the thumb on the low strings, i m a above).
"""

import re
import xml.etree.ElementTree as ET
import zipfile
from fractions import Fraction as F

NOTE_VALUE = {"Whole": 1, "Half": 2, "Quarter": 4, "Eighth": 8, "16th": 16, "32nd": 32, "64th": 64}


def _gpif(path):
    if path.endswith(".gpif"):
        return open(path, "rb").read()
    with zipfile.ZipFile(path) as z:
        return z.read("Content/score.gpif")


def _props(el):
    out = {}
    for p in el.iter("Property"):
        v = p.find("*")
        out[p.get("name")] = v
    return out


def _length(r):
    """A Rhythm element -> its length in quarter notes (exact)."""
    d = F(4, NOTE_VALUE[r.findtext("NoteValue")])
    dot = r.find("AugmentationDot")
    if dot is not None:
        d *= {"1": F(3, 2), "2": F(7, 4)}.get(dot.get("count"), 1)
    t = r.find("PrimaryTuplet")
    if t is not None:
        d *= F(int(t.get("den")), int(t.get("num")))
    return d


def read_gp(path):
    root = ET.fromstring(_gpif(path))
    score = root.find("Score")
    track = root.find("Tracks").find("Track")
    tp = _props(track)
    pitches = [int(x) for x in tp["Tuning"].text.split()] if "Tuning" in tp else [40, 45, 50, 55, 59, 64]
    capo = int(tp["CapoFret"].text) if "CapoFret" in tp and tp["CapoFret"].text else 0
    ids = lambda sec, tag: {e.get("id"): e for e in root.find(sec).findall(tag)}
    bars_x, voices, beats, notes, rhythms = ids("Bars", "Bar"), ids("Voices", "Voice"), ids("Beats", "Beat"), ids("Notes", "Note"), ids("Rhythms", "Rhythm")
    tempos = []
    for a in root.find("MasterTrack").iter("Automation"):
        if a.findtext("Type") == "Tempo":
            tempos.append((int(a.findtext("Bar")), float(a.findtext("Position") or 0), float(a.findtext("Value").split()[0])))
    stats = {"bends": 0, "palm": 0, "grace": 0, "voices": 0}
    bars = []
    for mb in root.find("MasterBars").findall("MasterBar"):
        num, den = (int(x) for x in mb.findtext("Time").split("/"))
        bar = {"num": num, "den": den, "length": F(num * 4, den), "notes": [], "section": None}
        sec = mb.find("Section")
        if sec is not None:
            bar["section"] = (sec.findtext("Text") or sec.findtext("Letter") or "").strip() or None
        bx = bars_x[mb.findtext("Bars").split()[0]]       # the first track
        vids = [v for v in bx.findtext("Voices").split() if v != "-1"]
        stats["voices"] = max(stats["voices"], len(vids))
        for vid in vids[:1]:
            q = F(0)
            for bid in voices[vid].findtext("Beats").split():
                b = beats[bid]
                d = _length(rhythms[b.find("Rhythm").get("ref")])
                if b.find("GraceNotes") is not None:
                    stats["grace"] += 1
                    continue
                for nid in (b.findtext("Notes") or "").split():
                    n = notes[nid]
                    pr = _props(n)
                    tie = n.find("Tie")
                    slide = int(pr["Slide"].text) if "Slide" in pr and pr["Slide"].text else 0
                    stats["bends"] += "Bended" in pr
                    stats["palm"] += "PalmMuted" in pr
                    bar["notes"].append({
                        "q": q, "len": d, "string": 6 - int(pr["String"].text), "fret": int(pr["Fret"].text),
                        "tied": tie is not None and tie.get("destination") == "true",
                        "hopo": "HopoOrigin" in pr, "slide": bool(slide & 3), "mute": "Muted" in pr,
                    })
                q += d
        bars.append(bar)
    _techniques(bars)
    return {"title": score.findtext("Title"), "artist": score.findtext("Artist"), "tabber": score.findtext("Tabber"),
            "tuning": pitches, "capo": capo, "bars": bars, "tempos": tempos, "stats": stats}


def _techniques(bars):
    """Ties lengthen the note before; a hammer-on, pull-off or legato slide
    into the next note on the string becomes that note's technique."""
    flat = [(bi, n) for bi, b in enumerate(bars) for n in sorted(b["notes"], key=lambda n: n["q"])]
    last = {}      # string -> the sounding note
    for bi, n in flat:
        s = n["string"]
        prev = last.get(s)
        if n["tied"] and prev:
            prev["len"] += n["len"]
            n["drop"] = True
            continue
        if prev and prev.get("to") is None and (prev["hopo"] or prev["slide"]) and prev["bar"] == bi and n["fret"] != prev["fret"]:
            kind = ("h" if n["fret"] > prev["fret"] else "o") if prev["hopo"] else ("/" if n["fret"] > prev["fret"] else "\\")
            prev["to"] = (kind, n["fret"])
            prev["len"] += n["len"]
            n["drop"] = True
            continue
        n["bar"] = bi
        n["to"] = None
        last[s] = n


def _grid(onsets, length, num):
    """Steps per bar: the coarsest of 2, 4, 3, 6 per beat that holds every
    onset exactly, else 4 per beat (a 32nd note is rounded). -> (steps, exact)."""
    beat = length / num
    for per in (2, 4, 3, 6):
        step = beat / per
        if all((q / step).denominator == 1 for q in onsets):
            return num * per, True
    return num * 4, False


def bar_steps(bar):
    """-> (steps text, notes kept, exact grid)."""
    from parts import fingers_for, token
    attacks = [n for n in bar["notes"] if not n.get("drop")]
    n_steps, exact = _grid([n["q"] for n in attacks], bar["length"], bar["num"])
    step = bar["length"] / n_steps
    slots = [[] for _ in range(n_steps)]
    for n in attacks:
        k = min(n_steps - 1, round(n["q"] / step))
        if all(m["string"] != n["string"] for m in slots[k]):
            slots[k].append(n)
    out = []
    for st in slots:
        if not st:
            out.append("-")
            continue
        assigned = [(k, 6 - n["string"], n["fret"]) for k, n in enumerate(st)]
        toks = []
        for k, f, s in sorted(fingers_for(assigned, bass=0, alt=0), key=lambda x: -x[2]):
            n = st[k]
            t = token(f, s, 0, 0, fret=n["fret"], tech=n["to"])
            toks.append(t + ("x" if n["mute"] else ""))
        out.append("+".join(toks))
    return " ".join(out), sum(len(s) for s in slots), exact


# ---------------------------------------------------------------- chord names from the notes

NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
TEMPLATES = [("", [0, 4, 7]), ("m", [0, 3, 7]), ("5", [0, 7]), ("sus2", [0, 2, 7]), ("sus4", [0, 5, 7]),
             ("7", [0, 4, 7, 10]), ("maj7", [0, 4, 7, 11]), ("m7", [0, 3, 7, 10]), ("add9", [0, 4, 7, 2]),
             ("6", [0, 4, 7, 9]), ("dim", [0, 3, 6])]


def _weights(notes, open_, q0, q1):
    """Pitch-class weights of the notes sounding in [q0, q1): their time in
    the window; and the lowest note attacked in it."""
    w = [0.0] * 12
    low = None
    for n in notes:
        if n.get("drop") or n["mute"]:
            continue
        a, b = max(q0, n["q"]), min(q1, n["q"] + n["len"])
        if b <= a and not (q0 <= n["q"] < q1):
            continue
        midi = open_[6 - n["string"]] + n["fret"]
        # The melody on the top strings counts for less than what's under it.
        w[midi % 12] += float(max(b - a, F(1, 8))) * (0.6 if n["string"] <= 2 else 1.0)
        if q0 <= n["q"] < q1 and (low is None or midi < low):
            low = midi
    return w, low


def _name(w, low):
    """The template that explains the notes best: (name, how much of the
    weight it covers), or (None, 0) for no notes."""
    total = sum(w)
    if total == 0:
        return None, 0.0
    bass = low % 12 if low is not None else None
    best = None
    for root in range(12):
        if w[root] == 0:
            continue
        for q, iv in TEMPLATES:
            tones = {(root + i) % 12 for i in iv}
            cover = sum(w[p] for p in tones) / total
            missing = sum(1 for p in tones if w[p] == 0)
            # Simpler chords win unless the extra tone carries real weight; the bass as root helps.
            score = cover - 0.18 * missing - 0.12 * max(0, len(iv) - 3) - 0.02 * len(iv) + (0.1 if root == bass else 0)
            if best is None or score > best[0]:
                best = (score, root, q, tones, cover)
    _, root, q, tones, cover = best
    name = NAMES[root] + q
    if bass is not None and bass != root and bass in tones:
        name += "/" + NAMES[bass]
    return name, cover


def bar_chords(bar, open_):
    """The bar's chord, or two when its halves differ: ([names], how well the
    notes fit 0..1). A bar with no notes: ([], 0)."""
    L = bar["length"]
    whole = _name(*_weights(bar["notes"], open_, F(0), L))
    if not whole[0]:
        return [], 0.0
    if bar["num"] % 2 == 0:
        wa, wb = _weights(bar["notes"], open_, F(0), L / 2), _weights(bar["notes"], open_, L / 2, L)
        a, b = _name(*wa), _name(*wb)
        # Two chords when the bass moves and each half is clearly its own chord.
        moved = wa[1] is not None and wb[1] is not None and wa[1] % 12 != wb[1] % 12
        if moved and a[0] and b[0] and _root(a[0]) != _root(b[0]) and a[1] >= 0.8 and b[1] >= 0.8:
            return [a[0], b[0]], round(min(a[1], b[1]), 2)
    return [whole[0]], round(whole[1], 2)


def _root(name):
    return re.match(r"^[A-G][#b]?", name).group(0)

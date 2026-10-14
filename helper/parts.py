"""Guitar parts from a recording (plan §8.4, Phase 5b step 4): what the hands
did, bar by bar, as a draft part for the app's Picking mode.

    1. the guitar stem (Demucs's 6-stem model; "other" when it's nearly empty)
    2. the chart's bars, from the beats and downbeats (analysis.py)
    3. notes (pitch, onset, length): basic-pitch (Spotify, Apache-2.0), run
       through its ONNX model
    4. strings and frets: a dynamic-programming pass over every playable
       position of each note in your tuning and capo, costing a note off the
       chord's shape, a stretch beyond the hand's span, moving the hand, and
       never two notes of one onset on a string. The frets held in a bar are
       its `shape`: a best-effort fingering
    5. the picking hand, inferred by rule (it can't be heard): the lowest note
       of an onset, on the chord's bass or alternate-bass string, is the thumb
       (pB / pA); the rest are i m a from their home strings
    6. each bar quantized to 8, 12 or 16 steps (6, 9, 12 in 3/4), whichever
       fits the onsets best, with @frets off the shape, and hammer-ons and
       pull-offs where the pitch changes without a new attack
    7. library patterns matched by edit distance (one edit or fewer gives the
       pattern and how well it matched); bars that repeat become the part's
       own patterns a, b, c...

Every bar says how sure it is; the part says source "detected" and
fingers "inferred". Pure apart from basic-pitch: tests/pc.test.mjs checks it
on parts rendered by the app's synth.
"""

import itertools
import math
import os
import re

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PATTERNS_JS = os.path.join(os.path.dirname(HERE), "js", "patterns.js")
STD = [40, 45, 50, 55, 59, 64]          # low string to high
HOME = {"i": 3, "m": 2, "a": 1}
SPAN = 4                                 # frets the hand covers without stretching
MAX_FRET = 15

PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
QUALITY_IV = {
    "": [0, 4, 7], "m": [0, 3, 7], "5": [0, 7], "dim": [0, 3, 6], "dim7": [0, 3, 6, 9], "aug": [0, 4, 8],
    "sus2": [0, 2, 7], "sus4": [0, 5, 7], "7sus4": [0, 5, 7, 10], "6": [0, 4, 7, 9], "7": [0, 4, 7, 10],
    "maj7": [0, 4, 7, 11], "m6": [0, 3, 7, 9], "m7": [0, 3, 7, 10], "mmaj7": [0, 3, 7, 11], "m7b5": [0, 3, 6, 10],
    "add9": [0, 4, 7, 2], "madd9": [0, 3, 7, 2], "9": [0, 4, 7, 10, 2], "maj9": [0, 4, 7, 11, 2], "m9": [0, 3, 7, 10, 2],
}
ALIASES = {"maj": "", "min": "m", "M7": "maj7", "min7": "m7", "sus": "sus4", "mMaj7": "mmaj7", "m(maj7)": "mmaj7", "ø": "m7b5", "°": "dim", "+": "aug"}


def parse_chord(name):
    """'F#m7/C#' -> (root pc, intervals, bass pc or None), or None."""
    m = re.match(r"^([A-G])([#b]?)([^/]*)(?:/([A-G])([#b]?))?$", str(name or "").strip())
    if not m:
        return None
    q = ALIASES.get(m.group(3), m.group(3))
    if q not in QUALITY_IV:
        return None
    acc = lambda a: 1 if a == "#" else -1 if a == "b" else 0
    root = (PC[m.group(1)] + acc(m.group(2))) % 12
    bass = (PC[m.group(4)] + acc(m.group(5))) % 12 if m.group(4) else None
    return root, QUALITY_IV[q], bass


def parse_tuning(notes):
    """'D A D F# A D' (low first; octaves optional) -> MIDI notes low to high."""
    if not notes:
        return STD[:]
    toks = re.split(r"[\s,]+", str(notes).strip())
    if len(toks) != 6:
        raise ValueError("A tuning needs six notes")
    out = []
    for i, t in enumerate(toks):
        m = re.match(r"^([A-Ga-g])([#b]?)(-?\d)?$", t)
        if not m:
            raise ValueError("Bad note " + t)
        pc = (PC[m.group(1).upper()] + (1 if m.group(2) == "#" else -1 if m.group(2) == "b" else 0)) % 12
        if m.group(3) is not None:
            out.append((int(m.group(3)) + 1) * 12 + pc)
        else:
            out.append(min((x for x in range(STD[i] - 12, STD[i] + 13) if x % 12 == pc), key=lambda x: (abs(x - STD[i]), x)))
    return out


# ---------------------------------------------------------------- shapes (as the app's js/chords.js searches them)

def difficulty(frets, bass_pc, open_):
    played = [(i, f) for i, f in enumerate(frets) if f is not None]
    if len(played) < 3:
        return 50
    fretted = [(i, f) for i, f in played if f > 0]
    score = 0.0
    if fretted:
        lo, hi = min(f for _, f in fretted), max(f for _, f in fretted)
        if hi - lo > 4:
            return 60
        fingers = len(fretted)
        barre = False
        if fingers > 4:
            barre = True
            fingers = 1 + len([1 for _, f in fretted if f > lo])
            if fingers > 4:
                return 40
        score += fingers * 0.6 + (hi - lo) * 0.5 + (4 if barre else 0) + max(0, lo - 3) * 0.5
    else:
        score += 0.5
    first, last = played[0][0], played[-1][0]
    score += 1.5 * sum(1 for i in range(first, last + 1) if frets[i] is None)
    if len(played) < 5:
        score += 0.8 if len(played) == 4 else 2
    if bass_pc is not None and (open_[played[0][0]] + played[0][1]) % 12 != bass_pc:
        score += 3
    return score


def shapes_for(name, open_, limit=6):
    """The easiest shapes for a chord in a tuning (open strings low to high,
    capo already added): [frets low to high], easiest first."""
    c = parse_chord(name)
    if not c:
        return []
    root, iv, bass = c
    pcs = [(root + i) % 12 for i in iv] + ([bass] if bass is not None else [])
    need = [(root + i) % 12 for k, i in enumerate(iv) if not (i == 7 and len(iv) >= 4) and not (i == 2 and len(iv) >= 6)]
    bass_pc = bass if bass is not None else root
    seen, found = set(), []
    for w in range(1, 11):
        opts = []
        for s in range(6):
            o = [None] + ([0] if open_[s] % 12 in pcs else []) + [f for f in range(w, w + 4) if (open_[s] + f) % 12 in pcs]
            opts.append(o)
        for combo in itertools.product(*opts):
            if combo in seen or sum(1 for f in combo if f is not None) < 3:
                continue
            seen.add(combo)
            notes = [(open_[s] + f) % 12 for s, f in enumerate(combo) if f is not None]
            if not all(p in notes for p in need):
                continue
            if bass is not None and notes[0] != bass:
                continue
            found.append((difficulty(combo, bass_pc, open_), -len(notes), list(combo)))
    found.sort(key=lambda x: (x[0], x[1]))
    return [f for _, _, f in found[:limit]]


def shape_strings(frets):
    """Bass and alternate-bass strings of a shape (string numbers, 1 = high), as
    Pimapeggio's parseVoicing: the lowest played string, and 4 or 3."""
    bass = 6
    while bass > 1 and frets[6 - bass] is None:
        bass -= 1
    return bass, (4 if bass >= 5 else 3)


# ---------------------------------------------------------------- notes

ONSET = 0.6   # basic-pitch's onset threshold: 0.7 merges a repeated bass note into one, 0.5 hears ringing strings again


def clean_notes(notes, amp_floor=0.45, harm=1.0, ring=0.9):
    """basic-pitch's extra notes, measured on parts rendered by the app's synth:
    quiet ones; an octave, twelfth or two octaves above a note at the same
    onset and quieter than it (its overtones); a pre-echo of a low note; and a
    string that's still ringing reported again, quieter, when another string
    is plucked."""
    out = [n for n in notes if n[3] >= amp_floor]
    out = [n for n in out if not any((n[2] - m[2]) in (12, 19, 24) and n[3] < harm * m[3] and abs(m[0] - n[0]) <= 0.04 for m in out if m is not n)]
    # A pre-echo (the stem separation smears a strong low note a little
    # earlier): a quieter note of the same pitch just before a louder one.
    out = [n for n in out if not any(m[2] == n[2] and 0.04 < m[0] - n[0] <= 0.15 and m[3] > n[3] for m in out)]
    keep = []
    for n in out:
        others = any(m is not n and m[2] != n[2] and abs(m[0] - n[0]) <= 0.03 for m in out)
        ringing = any(m[2] == n[2] and n[0] - 1.6 <= m[0] <= n[0] - 0.04 and m[1] >= n[0] - 0.03 and n[3] < ring * m[3] for m in out)
        if others and ringing:
            continue
        keep.append(n)
    return keep


def transcribe(stem_mono, sr, lowest_midi=36):
    """basic-pitch on the guitar stem -> [(onset, offset, midi, amplitude)], cleaned."""
    import tempfile
    import soundfile as sf
    import basic_pitch
    from basic_pitch.inference import Model
    model_path = os.path.join(os.path.dirname(basic_pitch.__file__), "saved_models", "icassp_2022", "nmp.onnx")
    if not hasattr(transcribe, "model"):
        transcribe.model = Model(model_path)
    from basic_pitch.inference import run_inference
    from basic_pitch.note_creation import model_output_to_notes
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "guitar.wav")
        sf.write(p, stem_mono, sr)
        output = run_inference(p, transcribe.model)
    events = model_output_to_notes(output, onset_thresh=ONSET, frame_thresh=0.3, min_note_len=5,
                                   min_freq=440 * 2 ** ((lowest_midi - 1 - 69) / 12), max_freq=1500,
                                   melodia_trick=True, include_pitch_bends=False)[1]
    return clean_notes(sorted((float(s), float(e), int(p), float(a)) for s, e, p, a, *_ in events))


def legato(notes, max_gap=0.18):
    """Hammer-ons and pull-offs: a note that starts while the one before it on
    a nearby pitch still sounds, softer, within max_gap: marked as the first
    note's technique instead of a new attack. -> (attacks, techniques {index: (type, midi, t)})."""
    tech = {}
    used = set()
    for j, (s, e, p, a) in enumerate(notes):
        for i in range(j - 1, max(-1, j - 6), -1):
            s0, e0, p0, a0 = notes[i]
            if i in used or s - s0 > max_gap or s <= s0 + 0.03:
                continue
            # On one string the first note stops as the second sounds; notes on
            # two strings ring on together (that's just picking).
            if 0 < abs(p - p0) <= 4 and s - 0.02 <= e0 <= s + 0.08 and a < a0 * 0.75:
                tech[i] = ("h" if p > p0 else "o", p, s)
                used.add(i)
                used.add(j)
                break
    attacks = [n for k, n in enumerate(notes) if not (k in used and k not in tech)]
    keep = {k for k in range(len(notes)) if not (k in used and k not in tech)}
    idx = {k: n for n, k in enumerate(sorted(keep))}
    return attacks, {idx[k]: v for k, v in tech.items() if k in idx}


def onset_groups(notes, window=0.03):
    """Notes starting within `window` of each other sound together."""
    groups = []
    for k, n in enumerate(notes):
        if groups and n[0] - groups[-1][0][1][0] <= window:
            groups[-1].append((k, n))
        else:
            groups.append([(k, n)])
    return groups


# ---------------------------------------------------------------- strings and frets (dynamic programming)

def positions(midi, open_):
    """Every (string index low..high, fret) that plays midi."""
    return [(s, midi - open_[s]) for s in range(6) if 0 <= midi - open_[s] <= MAX_FRET]


def assign_strings(groups, open_, shape_at):
    """Viterbi over onset groups. shape_at(t) -> the chord shape (frets low..high)
    at time t. Returns [[(note index, string, fret)], ...] per group, and the
    total cost."""
    states_per = []
    for g in groups:
        t = g[0][1][0]
        shape = shape_at(t)
        cands = [positions(n[2], open_) for _, n in g]
        states = []
        for combo in itertools.product(*cands) if all(cands) else []:
            strings = [s for s, _ in combo]
            if len(set(strings)) != len(strings):
                continue
            fretted = [f for _, f in combo if f > 0]
            span = (max(fretted) - min(fretted)) if fretted else 0
            cost = 0.0
            for s, f in combo:
                if shape and shape[s] is not None:
                    if shape[s] == f:
                        cost += 0
                    else:
                        cost += 1.5 + 0.2 * abs(shape[s] - f)
                elif shape:
                    cost += 1.0 + (0 if f == 0 else 0.1 * f)
                else:
                    cost += 0.15 * f
            if span > SPAN:
                cost += 3 * (span - SPAN)
            # The lowest note on the shape's bass or alternate-bass string: where
            # a thumb plays it (two strings in unison sound the same).
            if shape:
                b, a = shape_strings(shape)
                low = min(combo, key=lambda x: open_[x[0]] + x[1])
                if 6 - low[0] in (b, a):
                    cost -= 0.4
            pos = (sum(fretted) / len(fretted)) if fretted else None
            states.append((cost, combo, pos))
            if len(states) > 400:
                break
        if not states:
            states = [(10.0, tuple((max(range(6), key=lambda s: -abs(n[2] - open_[s] - 3)), max(0, n[2] - open_[max(range(6), key=lambda s: -abs(n[2] - open_[s] - 3))])) for _, n in g), None)]
        states.sort(key=lambda x: x[0])
        states_per.append(states[:60])

    # Viterbi: moving the hand costs, by how far.
    prev = [(c, None, pos) for c, _, pos in states_per[0]]
    back = []
    last_pos = [pos for _, _, pos in states_per[0]]
    for gi in range(1, len(states_per)):
        cur, bk, cpos = [], [], []
        for c, combo, pos in states_per[gi]:
            best, arg = None, 0
            for j, (pc, _, ppos) in enumerate(prev):
                move = 0.0
                lp = last_pos[j]
                if pos is not None and lp is not None:
                    move = 0.35 * abs(pos - lp)
                v = pc + c + move
                if best is None or v < best:
                    best, arg = v, j
            cur.append((best, arg, pos))
            bk.append(arg)
            cpos.append(pos if pos is not None else last_pos[arg])
        back.append(bk)
        prev = cur
        last_pos = cpos
    j = min(range(len(prev)), key=lambda k: prev[k][0])
    total = prev[j][0]
    path = [j]
    for bk in reversed(back):
        j = bk[j]
        path.append(j)
    path.reverse()
    out = []
    for gi, si in enumerate(path):
        combo = states_per[gi][si][1]
        out.append([(k, s, f) for (k, _), (s, f) in zip(groups[gi], combo)])
    return out, total


# ---------------------------------------------------------------- the picking hand (inferred)

def fingers_for(assigned, bass=6, alt=4):
    """[(note index, string idx low..high, fret)] at one onset -> [(note index,
    finger, string number 1..6)]: the thumb on the bass strings, i m a above."""
    sn = lambda s: 6 - s
    notes = sorted(assigned, key=lambda x: -sn(x[1]))   # low string first
    out = []
    rest = notes
    if notes:
        low = sn(notes[0][1])
        if low in (bass, alt) or low >= 4:
            out.append((notes[0][0], "p", low))
            rest = notes[1:]
    fingers = ["i", "m", "a"]
    strings = [sn(s) for _, s, _ in rest]
    if strings and len(set(strings)) == len(strings) and all(1 <= x <= 3 for x in strings) and len(strings) <= 3:
        # Their home strings: i on 3, m on 2, a on 1.
        for (k, s, _), x in zip(rest, strings):
            out.append((k, {3: "i", 2: "m", 1: "a"}[x], x))
    else:
        # Shifted up or down: i m a in order, low to high.
        for (k, s, _), f in zip(rest, fingers + ["a"] * 6):
            out.append((k, f, sn(s)))
    return out


def token(f, string, bass, alt, fret=None, shape=None, tech=None):
    """A note in the step notation: p on the bass strings is pB / pA; i m a on
    their home string need no number; @fret when it isn't the shape's."""
    if f == "p":
        t = "pB" if string == bass else "pA" if string == alt else "p" + str(string)
    else:
        t = f if HOME[f] == string else f + str(string)
    if fret is not None and (shape is None or shape[6 - string] != fret):
        t += "@" + str(fret)
    if tech:
        t += tech[0] + str(tech[1])
    return t


# ---------------------------------------------------------------- bars: quantize and match

def quantize(onsets, t0, t1, beats):
    """Onset times in a bar -> (steps per bar, [step index per onset], error 0..1)."""
    best = None
    dur = max(1e-3, t1 - t0)
    for per in (2, 3, 4):
        n = per * beats
        idx, err = [], 0.0
        for t in onsets:
            x = (t - t0) / dur * n
            k = int(round(x))
            err += abs(x - k)
            idx.append(min(n - 1, max(0, k)))
        err = err / max(1, len(onsets))
        # 16ths and triplets have to earn it: a little penalty for finer grids.
        score = err + (0 if per == 2 else 0.04 if per == 3 else 0.06)
        if best is None or score < best[0]:
            best = (score, n, idx, err)
    return best[1], best[2], best[3]


def load_library():
    """The app's library patterns (js/patterns.js PATTERN_DEFS): [(id, steps text, npb, bar beats)]."""
    with open(PATTERNS_JS, encoding="utf-8") as f:
        src = f.read()
    src = src[src.index("export const PATTERN_DEFS"):src.index("];", src.index("export const PATTERN_DEFS"))]
    out = []
    for m in re.finditer(r'\{\s*id:\s*"([^"]+)"[^}]*?steps:\s*"([^"]+)"[^}]*?npb:\s*(\d+)(?:[^}]*?bar:\s*(\d+))?[^}]*\}', src):
        out.append((m.group(1), m.group(2), int(m.group(3)), int(m.group(4)) if m.group(4) else None))
    return out


def resolve(tok, bass, alt):
    """A library or detected note -> (finger, string number)."""
    m = re.match(r"^([pima])([1-6]|B|A)?", tok)
    f, s = m.group(1), m.group(2)
    if s is None:
        s = bass if f == "p" else HOME[f]
    elif s == "B":
        s = bass
    elif s == "A":
        s = alt
    return f, int(s)


def step_sets(steps, bass, alt):
    return [frozenset(resolve(t, bass, alt) for t in st.split("+")) if st != "-" else frozenset() for st in steps]


def edit_distance(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (0 if a[i - 1] == b[j - 1] else 1))
            prev = cur
    return d[-1]


def match_library(steps, beats, bass, alt, library):
    """The library pattern this bar is, if one is within one edit: (id, hits, of)
    or None. Bars are compared by the strings that sound at each step (the
    fingers are inferred, and on some shapes the thumb's alternate string is a
    finger's home string too); matching finger names only break ties."""
    n = len(steps)
    mine_f = step_sets(steps, bass, alt)
    mine = [frozenset(s for _, s in st) for st in mine_f]
    best = None
    for pid, text, npb, bar in library:
        if bar and bar != beats:
            continue
        pat = text.split()
        slots = npb * beats
        if slots <= 0 or n % slots:
            continue
        stride = n // slots
        filled = ["-"] * n
        for k in range(slots):
            filled[k * stride] = pat[k % len(pat)]
        theirs_f = step_sets(filled, bass, alt)
        theirs = [frozenset(s for _, s in st) for st in theirs_f]
        dist = edit_distance(mine, theirs)
        hits = sum(1 for x, y in zip(mine, theirs) if x == y)
        fingers = sum(1 for x, y in zip(mine_f, theirs_f) if x == y)
        # The closest; then the most steps right; then the fingers that agree;
        # then the shortest pattern (the simplest description of the bar).
        key = (dist, -hits, -fingers, len(pat))
        if dist <= 1 and (best is None or key < best[0]):
            best = (key, pid, hits, n)
    return (best[1], best[2], best[3]) if best else None


# ---------------------------------------------------------------- the whole pass

def detect_parts(chart, stem_mono, sr, tuning_notes=None, capo=0, notes=None):
    """chart: the bundle's chart.json (bars with t, sections, form, analysis.segments).
    Returns ({section name: part}, stats). notes: [(onset, offset, midi, amp)] to
    skip transcription (tests)."""
    open_ = [m + capo for m in parse_tuning(tuning_notes)]
    beats = 3 if chart.get("time") == "3/4" else 4
    bars = chart["bars"]
    if not bars:
        return {}, {}
    t1s = [b["t"] for b in bars[1:]] + [bars[-1]["t"] + (bars[-1]["t"] - bars[-2]["t"] if len(bars) > 1 else 2)]
    if notes is None:
        notes = transcribe(stem_mono, sr, lowest_midi=min(open_))
    attacks, techs = legato(notes)
    groups = onset_groups(attacks)

    shape_cache = {}

    def shape_of(name):
        if name not in shape_cache:
            sh = shapes_for(name, open_)
            shape_cache[name] = sh[0] if sh else None
        return shape_cache[name]

    def chord_at(t):
        bi = max(0, max((i for i, b in enumerate(bars) if b["t"] <= t + 0.02), default=0))
        b = bars[bi]
        k = min(len(b["chords"]) - 1, int((t - b["t"]) / max(0.01, t1s[bi] - b["t"]) * len(b["chords"])))
        return b["chords"][max(0, k)]

    assigned, cost = assign_strings(groups, open_, lambda t: shape_of(chord_at(t)))
    # The notes as found, with their strings (1 = high) and frets: for checking.
    found_notes = [[round(g[0][1][0], 3), attacks[k][2], 6 - s, f] for g, a in zip(groups, assigned) for k, s, f in a]

    # Per bar: its onsets and notes.
    per_bar = [[] for _ in bars]
    for g, a in zip(groups, assigned):
        t = g[0][1][0]
        bi = max((i for i, b in enumerate(bars) if b["t"] <= t + 0.04), default=-1)
        if bi >= 0 and t < t1s[bi] + 0.04:
            per_bar[bi].append((t, g, a))

    library = load_library()
    detected = []   # per chart bar: {steps, shape, confidence, match}
    for bi, items in enumerate(per_bar):
        b = bars[bi]
        if not items:
            detected.append(None)
            continue
        name = b["chords"][0]
        shape = shape_of(name)
        # The frets held through the bar: the most common fret per string.
        held = [None] * 6
        for s in range(6):
            fr = [f for _, _, a in items for (_, ss, f) in a if ss == s]
            if fr and (len(fr) >= 2 or not shape or shape[s] is None):
                held[s] = max(set(fr), key=fr.count)
        bar_shape = [held[s] if held[s] is not None else (shape[s] if shape else None) for s in range(6)]
        # The thumb's strings come from the chord's shape (a stray note shouldn't move them).
        bass, alt = shape_strings(shape) if shape else shape_strings(bar_shape) if any(f is not None for f in bar_shape) else (6, 4)
        n, idx, qerr = quantize([t for t, _, _ in items], b["t"], t1s[bi], beats)
        steps = [[] for _ in range(n)]
        amps = []
        for (t, g, a), k in zip(items, idx):
            byk = {kk: (s, f) for kk, s, f in a}
            amp = {kk: n[3] for kk, n in g}
            for kk, finger, string in fingers_for(a, bass, alt):
                s_idx, fret = byk[kk]
                tech = techs.get(kk)
                tech_t = (tech[0], tech[1] - open_[s_idx]) if tech and 0 <= tech[1] - open_[s_idx] <= MAX_FRET else None
                tok = token(finger, string, bass, alt, fret, bar_shape, tech_t)
                # Two onsets quantized onto one step: keep one note per string.
                if not any(resolve(x, bass, alt)[1] == string for x in steps[k]):
                    steps[k].append(tok)
                amps.append(amp.get(kk, 0.5))
        text = [("+".join(sorted(st, key=lambda x: "pima".index(x[0]))) if st else "-") for st in steps]
        conf = max(0.0, min(1.0, 0.55 * (1 - 2 * qerr) + 0.45 * min(1.0, float(np.mean(amps)) * 2 if amps else 0.5)))
        plain = not any(re.search(r"@|[ho]\d", t) for t in text)
        m = match_library(text, beats, bass, alt, library) if plain else None
        detected.append({"steps": text, "shape": bar_shape, "confidence": round(conf, 2), "match": m, "n": n})

    # Sections: each section's bars, voting across the times it's played.
    segs = (chart.get("analysis") or {}).get("segments")
    if segs:
        spans = [(s["name"], list(range(s["bars"][0], s["bars"][1] + 1))) for s in segs]
    else:
        spans, i = [], 0
        for name in chart.get("form") or [s["name"] for s in chart["sections"]]:
            sec = next((s for s in chart["sections"] if s["name"] == name), None)
            if not sec:
                continue
            nb = len([x for x in sec["chords"].split("|") if x.strip()])
            spans.append((name, list(range(i, min(i + nb, len(bars))))))
            i += nb
    parts = {}
    stats = {"notes": len(notes), "onsets": len(groups), "bars": len(bars), "cost": round(cost, 1), "found": found_notes}
    for name, span in spans:
        if name in parts:
            continue
        occurrences = [[detected[bi] if bi < len(detected) else None for bi in sp] for nm, sp in spans if nm == name]
        nbars = len(span)
        part_bars = []
        for k in range(nbars):
            cands = [occ[k] for occ in occurrences if k < len(occ) and occ[k]]
            if not cands:
                part_bars.append({})
                continue
            texts = [" ".join(c["steps"]) for c in cands]
            best = max(set(texts), key=texts.count)
            c = next(c for c in cands if " ".join(c["steps"]) == best)
            agree = texts.count(best) / len(texts)
            bar = {}
            if c["match"]:
                bar["pattern"] = c["match"][0]
                bar["match"] = {"pattern": c["match"][0], "hits": c["match"][1], "of": c["match"][2]}
            else:
                bar["steps"] = best
                bar["match"] = None
            bar["shape"] = "".join("x" if f is None else str(f) for f in c["shape"]) if all(f is None or f < 10 for f in c["shape"]) else "-".join("x" if f is None else str(f) for f in c["shape"])
            bar["confidence"] = round(c["confidence"] * (0.6 + 0.4 * agree), 2)
            part_bars.append(bar)
        # Written-out bars that repeat become the part's own patterns a, b, c...
        texts = [b.get("steps") for b in part_bars if b.get("steps")]
        own = {}
        for t in sorted(set(texts), key=lambda x: -texts.count(x)):
            if texts.count(t) >= 2 and len(own) < 6:
                own[t] = "abcdef"[len(own)]
        for b in part_bars:
            if b.get("steps") in own:
                key = own[b["steps"]]
                n = len(b["steps"].split())
                b["pattern"] = key
                b["match"] = {"pattern": key, "hits": n, "of": n}
                del b["steps"]
        # A sure bar that plays just what the bar before it did: {}.
        prev = None
        for i, b in enumerate(part_bars):
            sig = (b.get("pattern"), b.get("steps"), b.get("shape"))
            if b and prev == sig and (b.get("confidence") or 0) >= 0.6:
                part_bars[i] = {}
            prev = sig if b else prev
        if not any(part_bars):
            continue
        parts[name] = {
            "source": "detected", "detector": None, "fingers": "inferred",
            "patterns": {k: {"steps": t, "npb": max(1, round(len(t.split()) / beats))} for t, k in own.items()},
            "bars": part_bars,
        }
    return parts, stats

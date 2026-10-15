"""The synth band's transcribed parts (plan §8.2 and §9.2, Phase 6): from a
bundle's stems, the bass line and the vocal melody as notes (basic-pitch),
and the drums as onsets sorted into kick, snare and hat by where their energy
is (onset classes: no drum-transcription model). The app plays them in place
of its generated parts, labelled "transcribed", on the recording's clock.

    python helper/arrange.py private/songs/<slug>     (in the helper's venv)

writes arrangement.json into the bundle (and lists it in bundle.json);
tools/ship-bundle.mjs ships it with the song. analysis.py runs it too, for
every new analysis.

arrangement.json: { app, kind: "arrangement", version, detector,
  tracks: { bass | melody: { kind: "transcribed", from, events: [{ t, dur, midi, vel }] },
            drums: { kind: "transcribed", from, events: [{ t, drum, vel }] } } }
"""

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SR = 22050
DETECTOR = "basic-pitch (bass and vocal stems), drum onsets by frequency band, on the PC helper"


def basic_pitch_notes(mono, sr, low, high, onset=0.5, frame=0.3, min_len=6):
    """basic-pitch on one stem -> [(onset, offset, midi, amplitude)] between MIDI low and high."""
    import tempfile
    import soundfile as sf
    import basic_pitch
    from basic_pitch.inference import Model, run_inference
    from basic_pitch.note_creation import model_output_to_notes
    if not hasattr(basic_pitch_notes, "model"):
        basic_pitch_notes.model = Model(os.path.join(os.path.dirname(basic_pitch.__file__), "saved_models", "icassp_2022", "nmp.onnx"))
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "stem.wav")
        sf.write(p, mono, sr)
        out = run_inference(p, basic_pitch_notes.model)
    hz = lambda m: 440 * 2 ** ((m - 69) / 12)
    ev = model_output_to_notes(out, onset_thresh=onset, frame_thresh=frame, min_note_len=min_len,
                               min_freq=hz(low - 0.5), max_freq=hz(high + 0.5), melodia_trick=True, include_pitch_bends=False)[1]
    return sorted((float(s), float(e), int(p), float(a)) for s, e, p, a, *_ in ev if low <= int(p) <= high)


def one_line(notes, min_dur=0.07):
    """A single line (a bass or a voice plays one note at a time): where notes
    overlap the louder one wins and the other is cut or dropped."""
    notes = [n for n in notes if n[1] - n[0] >= min_dur]
    out = []
    for n in sorted(notes, key=lambda x: x[0]):
        if out and n[0] < out[-1][1] - 0.02:
            prev = out[-1]
            if abs(n[0] - prev[0]) < 0.05:
                # Same onset: keep the louder (an octave or overtone is the quieter one).
                if n[3] > prev[3]:
                    out[-1] = n
                continue
            # A new note: the last one stops here.
            out[-1] = (prev[0], n[0], prev[2], prev[3])
        out.append(n)
    return [n for n in out if n[1] - n[0] >= min_dur]


def events(notes):
    amps = [n[3] for n in notes] or [1]
    top = float(np.percentile(amps, 95)) or 1
    return [{"t": round(s, 3), "dur": round(e - s, 3), "midi": p, "vel": round(min(1, 0.4 + 0.6 * a / top), 2)} for s, e, p, a in notes]


def drum_hits(mono, sr):
    """Drum-stem onsets -> [{ t, drum, vel }]. Each hit's energy in four bands
    (under 150 Hz, to 1 kHz, to 5 kHz, above), grouped into three kinds of
    hit for this song (k-means): the darkest group is the kick, the brightest
    the hat, the one between the snare. Kits differ (a suitcase kick thumps
    around 200 Hz, a tambourine plays the hat's part), so the groups come from
    the song, not fixed thresholds."""
    import librosa
    env = librosa.onset.onset_strength(y=mono, sr=sr, hop_length=256)
    times = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=256, units="time", backtrack=False, delta=0.08)
    if not len(times):
        return []
    S = np.abs(librosa.stft(mono, n_fft=2048, hop_length=256)) ** 2
    fr = librosa.fft_frequencies(sr=sr, n_fft=2048)
    bands = [fr < 150, (fr >= 150) & (fr < 1000), (fr >= 1000) & (fr < 5000), fr >= 5000]
    feats = []
    for t in times:
        f = int(t * sr / 256)
        w = S[:, f:f + 6].sum(1)
        tot = w.sum() + 1e-12
        feats.append([w[b].sum() / tot for b in bands])
    X = np.array(feats)
    bright = X @ np.array([0, 1, 2, 3])          # 0 (all low) .. 3 (all high)
    order = np.argsort(bright)

    def kmeans(k):
        # Started from the darkest, middle and brightest hits.
        C = X[[order[0], order[len(order) // 2], order[-1]][:k] if k == 3 else [order[0], order[-1]][:k]].copy()
        for _ in range(30):
            lab = np.argmin(((X[:, None, :] - C[None, :, :]) ** 2).sum(2), 1)
            newC = np.array([X[lab == j].mean(0) if (lab == j).any() else C[j] for j in range(k)])
            if np.allclose(newC, C):
                break
            C = newC
        return C, lab

    k = min(3, len(X))
    C, lab = kmeans(k)
    # A group of a few odd hits isn't a drum of its own: two groups, kick and hat.
    if k == 3 and min((lab == j).sum() for j in range(3)) < 0.05 * len(X):
        k = 2
        C, lab = kmeans(2)
    cb = C @ np.array([0, 1, 2, 3])
    rank = np.argsort(np.argsort(cb))            # 0 darkest .. k-1 brightest
    names = {0: "kick", k - 1: "hat"}
    names.setdefault(1, "snare")
    strength = env / (np.percentile(env, 99) + 1e-9)
    out = []
    for t, j in zip(times, lab):
        f = int(t * sr / 256)
        vel = float(min(1, 0.35 + 0.65 * strength[min(f, len(strength) - 1)]))
        d = names[int(rank[j])]
        out.append({"t": round(float(t), 3), "drum": d, "vel": round(vel * (0.7 if d == "hat" else 1), 2)})
    return out


QUIET = 25   # dB under the loudest stem: that stem is bleed (an instrumental's "vocals"), so no track


def arrangement(stems, sr=SR):
    """stems: {name: mono float array at sr} -> arrangement.json's contents
    (tracks only for stems that are there and not just bleed)."""
    db = {k: 20 * np.log10(float(np.sqrt(np.mean(np.square(v)))) + 1e-9) for k, v in stems.items()}
    loud = max(db.values()) if db else 0
    stems = {k: v for k, v in stems.items() if db[k] >= loud - QUIET}
    tracks = {}
    if "bass" in stems:
        tracks["bass"] = {"kind": "transcribed", "from": "the bass stem", "events": events(one_line(basic_pitch_notes(stems["bass"], sr, 28, 55, onset=0.5)))}
    if "vocals" in stems:
        tracks["melody"] = {"kind": "transcribed", "from": "the vocal stem", "events": events(one_line(basic_pitch_notes(stems["vocals"], sr, 45, 84, onset=0.5), min_dur=0.09))}
    if "drums" in stems:
        tracks["drums"] = {"kind": "transcribed", "from": "the drum stem", "events": drum_hits(stems["drums"], sr)}
    return {"app": "songbook", "kind": "arrangement", "version": 1, "detector": DETECTOR, "tracks": tracks}


def main():
    import analysis
    bundle = sys.argv[1].rstrip("/")
    m = json.load(open(os.path.join(bundle, "bundle.json")))
    # Every stem, so "the loudest" is the song's loudest.
    stems = {s["name"]: analysis.decode(os.path.join(bundle, s["file"]), sr=SR, channels=1)[0] for s in m["stems"]}
    doc = arrangement(stems)
    json.dump(doc, open(os.path.join(bundle, "arrangement.json"), "w"), indent=0)
    if "arrangement.json" not in m["files"]:
        m["files"].append("arrangement.json")
    m["arrangement"] = True
    json.dump(m, open(os.path.join(bundle, "bundle.json"), "w"), indent=1)
    print(", ".join(f"{k}: {len(v['events'])} {'hits' if k == 'drums' else 'notes'}" for k, v in doc["tracks"].items()))


if __name__ == "__main__":
    main()

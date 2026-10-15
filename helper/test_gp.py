"""Checks for gp.py on a small made-up tab (no GPU, no audio):
    python helper/test_gp.py      (in the helper's venv)"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gp  # noqa: E402

# Open D. Bar 1: eighths; D bass + F# on string 2, a hammer-on 0h2 on string 3,
# a tied note, a muted note. Bar 2: a 16th-note slide 4/7 on string 2, then a
# whole-bar rest after it. Bar 3: 3/4 of nothing (empty).
NOTE = "<Note id='{id}'>{tie}<Properties><Property name='String'><String>{s}</String></Property><Property name='Fret'><Fret>{f}</Fret></Property>{extra}</Properties></Note>"
notes = [
    (0, 0, 0, ""), (1, 4, 9, ""),                      # string 6 (gp 0) fret 0; string 2 (gp 4) fret 9
    (2, 3, 0, "<Property name='HopoOrigin'><Enable/></Property>"), (3, 3, 2, "<Property name='HopoDestination'><Enable/></Property>"),
    (4, 0, 0, ""), (5, 0, 0, ""),                      # 5 is tied to 4
    (6, 1, 3, "<Property name='Muted'><Enable/></Property>"),
    (7, 4, 4, "<Property name='Slide'><Flags>2</Flags></Property>"), (8, 4, 7, ""),
]
xml_notes = "".join(NOTE.format(id=i, s=s, f=f, extra=x, tie="<Tie origin='false' destination='true'/>" if i == 5 else "") for i, s, f, x in notes)
beats = [  # (id, rhythm, notes)
    (0, 0, "0 1"), (1, 0, "2"), (2, 0, "3"), (3, 0, "4"), (4, 0, "5"), (5, 0, "6"), (6, 2, ""),
    (7, 1, "7"), (8, 1, "8"), (9, 3, ""), (10, 4, ""),
]
xml_beats = "".join(f"<Beat id='{i}'><Rhythm ref='{r}'/>" + (f"<Notes>{n}</Notes>" if n else "") + "</Beat>" for i, r, n in beats)
GPIF = f"""<GPIF><Score><Title>Test</Title><Artist>Nobody</Artist><Tabber>Me</Tabber></Score>
<MasterTrack><Automations><Automation><Type>Tempo</Type><Bar>0</Bar><Position>0</Position><Value>100 2</Value></Automation></Automations></MasterTrack>
<Tracks><Track id='0'><Name>Guitar</Name><Properties><Property name='Tuning'><Pitches>38 45 50 54 57 62</Pitches></Property></Properties></Track></Tracks>
<MasterBars><MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar><MasterBar><Time>4/4</Time><Bars>1</Bars></MasterBar><MasterBar><Time>3/4</Time><Bars>2</Bars></MasterBar></MasterBars>
<Bars><Bar id='0'><Voices>0 -1 -1 -1</Voices></Bar><Bar id='1'><Voices>1 -1 -1 -1</Voices></Bar><Bar id='2'><Voices>2 -1 -1 -1</Voices></Bar></Bars>
<Voices><Voice id='0'><Beats>0 1 2 3 4 5 6</Beats></Voice><Voice id='1'><Beats>7 8 9 10</Beats></Voice><Voice id='2'><Beats>10</Beats></Voice></Voices>
<Beats>{xml_beats}</Beats><Notes>{xml_notes}</Notes>
<Rhythms><Rhythm id='0'><NoteValue>Eighth</NoteValue></Rhythm><Rhythm id='1'><NoteValue>16th</NoteValue></Rhythm><Rhythm id='2'><NoteValue>Quarter</NoteValue></Rhythm>
<Rhythm id='3'><AugmentationDot count='1'/><NoteValue>Eighth</NoteValue></Rhythm><Rhythm id='4'><AugmentationDot count='1'/><NoteValue>Half</NoteValue></Rhythm></Rhythms></GPIF>"""

fails = 0


def eq(name, got, want):
    global fails
    ok = got == want
    fails += not ok
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  got {got!r}, want {want!r}"))


with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "t.gpif")
    open(p, "w").write(GPIF)
    tab = gp.read_gp(p)
eq("tuning, low to high", tab["tuning"], [38, 45, 50, 54, 57, 62])
eq("bars and their lengths", [(b["num"], float(b["length"])) for b in tab["bars"]], [(4, 4.0), (4, 4.0), (3, 3.0)])
eq("bar 1 as steps: thumb on 6, m on 2, the hammer-on on its first note, the tie not picked again, the mute",
   gp.bar_steps(tab["bars"][0])[0], "p6@0+m@9 i@0h2 - p6@0 - p5@3x - -")
eq("bar 2: the legato slide on its first note (its second note isn't picked, so eighths do)", gp.bar_steps(tab["bars"][1])[0], "m@4/7 - - - - - - -")
eq("bar 2's grid is exact", gp.bar_steps(tab["bars"][1])[2], True)
eq("an empty bar", (gp.bar_steps(tab["bars"][2])[0], gp.bar_chords(tab["bars"][2], tab["tuning"])), ("- - - - - -", ([], 0.0)))
eq("chord names from the notes: D bass with F# and E", gp.bar_chords(tab["bars"][0], tab["tuning"])[0][0][0], "D")
print(f"\n== gp: {'all passed' if not fails else str(fails) + ' failed'}")
sys.exit(1 if fails else 0)

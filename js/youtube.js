// YouTube links without the helper: the official IFrame player, driven with
// the same interface as FileEngine. The page can't touch YouTube's audio (it's
// cross-origin), so speed uses YouTube's own pitch-preserving playback rate
// and pitch shifting isn't available; looping, count-in and the speed trainer
// all work. From speedy-pitcher's js/youtube.js (the owner's app); count-in
// clicks go through the Songbook's "click" track.

import { audioContext, track } from "./audio.js";
import { makeClick } from "./engine.js";
import { trainerRate } from "./trainer.js";

let apiPromise = null;

function loadApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => { apiPromise = null; reject(new Error("Couldn't reach YouTube.")); };
      document.head.appendChild(s);
    });
  }
  return apiPromise;
}

export function parseYouTubeId(text) {
  const s = (text || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, "");
    if (host === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch (e) { /* not a URL */ }
  return null;
}

export async function youTubeTitle(id) {
  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id));
    if (r.ok) return (await r.json()).title;
  } catch (e) { /* offline or blocked */ }
  return null;
}

const YT_ERRORS = {
  2: "That doesn't look like a valid YouTube video.",
  5: "This video can't be played in an embedded player.",
  100: "This video was removed or is private.",
  101: "The owner doesn't allow this video to be played outside YouTube.",
  150: "The owner doesn't allow this video to be played outside YouTube.",
};

export class YouTubeEngine extends EventTarget {
  constructor(hostEl) {
    super();
    this.kind = "youtube";
    this.host = hostEl;
    this.duration = 0;
    this.playing = false;
    this.rate = 1;
    this.loop = { a: null, b: null, on: false };
    this.countIn = { beats: 0, beatSec: 0.6 };
    this.trainer = null;
    this.counting = null;     // { until, timer } during a count-in
    this.passes = 0;
    this.lastPos = 0;
    this.timer = setInterval(() => this.tick(), 40);
  }

  async load(videoId, startAt = 0) {
    await loadApi();
    this.destroyPlayer();
    const el = document.createElement("div");
    this.host.appendChild(el);
    this.wantPlay = false;
    await new Promise((resolve, reject) => {
      this.player = new YT.Player(el, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { playsinline: 1, rel: 0, start: Math.floor(startAt) },
        events: {
          onReady: () => {
            this.duration = this.player.getDuration() || 0;
            this.player.setPlaybackRate(this.rate);
            if (startAt) this.player.seekTo(startAt, true);
            resolve();
          },
          onError: (e) => {
            const msg = YT_ERRORS[e.data] || "YouTube couldn't play this video.";
            this.emit("error", { message: msg });
            reject(new Error(msg));
          },
          onStateChange: (e) => this.onState(e.data),
        },
      });
    });
  }

  destroyPlayer() {
    this.cancelCountIn();
    if (this.player) { try { this.player.destroy(); } catch (e) { /* gone */ } }
    this.player = null;
    this.host.innerHTML = "";
    this.playing = false;
  }

  unload() { this.destroyPlayer(); this.duration = 0; }

  onState(s) {
    const YTS = YT.PlayerState;
    if (s === YTS.PLAYING || s === YTS.BUFFERING) {
      if (!this.duration) this.duration = this.player.getDuration() || 0;
      if (!this.playing && !this.counting) { this.playing = true; this.emit("state"); }
    } else if (s === YTS.PAUSED || s === YTS.ENDED) {
      // Our own pause for a count-in shouldn't look like the user stopping.
      if (this.counting) return;
      if (this.playing) { this.playing = false; this.emit("state"); }
      if (s === YTS.ENDED) this.emit("ended");
    }
  }

  get position() {
    if (!this.player || !this.player.getCurrentTime) return 0;
    if (this.counting) return this.counting.at;
    return this.player.getCurrentTime() || 0;
  }

  get currentRate() { return this.rate; }
  get inCountIn() { return !!this.counting; }

  play() {
    if (!this.player) return;
    const { a, b, on } = this.loop;
    let pos = this.position;
    if (on && a !== null && b !== null && (pos < a || pos >= b - 0.05)) { pos = a; this.player.seekTo(a, true); }
    if (this.trainer) this.applyRate(this.trainer.rate);
    this.playing = true;
    this.emit("state");
    if (this.countIn.beats > 0) this.doCountIn(pos, null);
    else this.player.playVideo();
    this.checkStarted();
  }

  // iOS won't let a page start an embedded video until it has been tapped once.
  checkStarted() {
    clearTimeout(this.startCheck);
    const t0 = this.position;
    this.startCheck = setTimeout(() => {
      if (this.playing && !this.counting && this.player && this.player.getPlayerState() !== YT.PlayerState.PLAYING && Math.abs(this.position - t0) < 0.05) {
        this.emit("needs-tap");
      }
    }, 2500 + (this.countIn.beats * this.countIn.beatSec / this.rate) * 1000);
  }

  pause() {
    this.cancelCountIn();
    if (this.player) this.player.pauseVideo();
    if (this.playing) { this.playing = false; this.emit("state"); }
  }

  seek(t) {
    t = Math.max(0, Math.min(this.duration || t, t));
    this.cancelCountIn();
    if (this.player) {
      this.player.seekTo(t, true);
      if (this.playing) this.player.playVideo();
    }
    this.emit("seek");
  }

  applyRate(r) {
    // YouTube accepts 0.25–2 in 0.05 steps.
    r = Math.round(Math.max(0.25, Math.min(2, r)) * 20) / 20;
    this.rate = r;
    if (this.player && this.player.setPlaybackRate) this.player.setPlaybackRate(r);
  }

  setRate(r) {
    this.applyRate(r);
    if (this.trainer) Object.assign(this.trainer, { rate: this.rate, baseRate: this.rate, basePasses: this.trainer.passes });
  }

  setPitch() { /* not possible with the embedded player */ }

  setLoop(a, b, on) {
    // A new loop starts the pass count (and the trainer's steps) over.
    if (a !== this.loop.a || b !== this.loop.b) {
      this.passes = 0;
      if (this.trainer) Object.assign(this.trainer, { passes: 0, basePasses: 0, baseRate: this.trainer.rate });
    }
    this.loop = { a, b, on };
  }

  setCountIn(beats, beatSec) { this.countIn = { beats, beatSec }; }

  setTrainer(t) {
    this.trainer = t ? { ...t, passes: 0, basePasses: 0, baseRate: t.start, rate: t.start } : null;
    if (t) this.applyRate(t.start);
    this.passes = 0;
    this.emit("rate");
  }

  doCountIn(at, pass) {
    const c = audioContext();
    if (!this.clickHi) { this.clickHi = makeClick(c, 1760); this.clickLo = makeClick(c, 1175); }
    if (c.state !== "running") c.resume().catch(() => {});
    const beats = this.countIn.beats, beatDur = this.countIn.beatSec / this.rate;
    const t0 = c.currentTime + 0.05;
    const srcs = [];
    for (let i = 0; i < beats; i++) {
      const src = c.createBufferSource();
      src.buffer = i === 0 ? this.clickHi : this.clickLo;
      src.connect(track("click").gain);
      src.start(t0 + i * beatDur);
      srcs.push(src);
      setTimeout(() => this.emit("beat", { beat: i + 1, beats, pass }), (0.05 + i * beatDur) * 1000);
    }
    const timer = setTimeout(() => {
      this.counting = null;
      if (this.player && this.playing) this.player.playVideo();
    }, (0.05 + beats * beatDur) * 1000 - 30);
    this.counting = { at, timer, srcs };
  }

  cancelCountIn() {
    if (!this.counting) return;
    clearTimeout(this.counting.timer);
    this.counting.srcs.forEach((s) => { try { s.stop(); } catch (e) { /* done */ } });
    this.counting = null;
  }

  tick() {
    if (!this.player || !this.playing || this.counting || !this.player.getCurrentTime) return;
    const { a, b, on } = this.loop;
    if (!on || a === null || b === null || b - a < 0.1) return;
    const pos = this.player.getCurrentTime();
    // Only wrap when playback runs into B, not after a seek past it.
    if (pos >= b && this.lastPos < b && this.lastPos > a - 0.5) this.wrap();
    this.lastPos = this.player.getCurrentTime();
  }

  wrap() {
    const { a } = this.loop;
    const passes = (this.trainer ? this.trainer.passes : this.passes) + 1;
    this.passes = passes;
    if (this.trainer) {
      this.trainer.passes = passes;
      this.trainer.rate = trainerRate(this.trainer, passes);
      if (this.trainer.rate !== this.rate) { this.applyRate(this.trainer.rate); this.emit("rate"); }
    }
    this.emit("wrap", { passes, rate: this.rate });
    this.lastPos = a;
    this.player.seekTo(a, true);
    if (this.countIn.beats > 0) {
      this.player.pauseVideo();
      this.doCountIn(a, passes);
    }
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

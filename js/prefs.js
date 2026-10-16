// Small app-wide settings kept in localStorage (per device).

const LRCLIB_KEY = "songbook-lrclib";

// Synced-lyrics lookups on LRCLIB: on unless turned off in Settings. Nothing
// is sent until you tap "Find on LRCLIB".
export function lrclibOn() {
  try { return localStorage.getItem(LRCLIB_KEY) !== "off"; } catch (e) { return true; }
}

export function setLrclib(on) {
  try { localStorage.setItem(LRCLIB_KEY, on ? "on" : "off"); } catch (e) { /* blocked */ }
}

const FOLLOW_KEY = "songbook-follow";

// The tab or sheet scrolls to what's playing: off unless you turn it on.
export function followOn() {
  try { return localStorage.getItem(FOLLOW_KEY) === "on"; } catch (e) { return false; }
}

export function setFollow(on) {
  try { localStorage.setItem(FOLLOW_KEY, on ? "on" : "off"); } catch (e) { /* blocked */ }
}

# Signalsmith Stretch (vendored)

`SignalsmithStretch.mjs` is the prebuilt Web Audio release of
[Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) from npm
(`signalsmith-stretch@1.3.2`, MIT, see `LICENSE.txt`): the AudioWorklet code
with the WebAssembly embedded, in one file. Copied from the owner's
speedy-pitcher (`vendor/signalsmith-stretch/`), where it was chosen over
SoundTouch and Rubber Band (see that repo's README).

## Local patch

One change, marked `speedy-pitcher patch` in the file. In 1.3.2,
`schedule()` cleans up its timeline using the *new event's* time instead of the
current audio time, so scheduling anything ahead deletes the segment that is
playing now. The patch makes the cleanup use `currentTime`. Seamless loop jumps
and count-ins scheduled ahead depend on it.

To update: copy the new `SignalsmithStretch.mjs` from the npm package, check
whether the bug is fixed upstream, and re-apply the patch if not.

# essentia.js (vendored)

From npm `essentia.js@0.1.3` (MTG, Universitat Pompeu Fabra), AGPL-3.0, see
`LICENSE`. The Songbook's source is public, which the AGPL asks for.

- `essentia-wasm.web.js` + `essentia-wasm.web.wasm`: the WebAssembly build
  (Emscripten loader and binary).
- `essentia.js-core.js`: the JavaScript API, as a script that defines `Essentia`.

They're loaded only by `js/analysis-worker.js`, the first time you analyse a
recording, and cached by the service worker then (not precached: ~2.5 MB).
Unchanged from the package. The web build expects a page, so the worker gives it
a minimal `document` stand-in and a `locateFile` for the .wasm.

# chords-db (vendored subset)

`guitar.json` is built from [chords-db](https://github.com/tombatossals/chords-db)
by David Rubert (MIT, see `LICENSE`), npm `@tombatossals/chords-db@0.5.1`.
`tools/build-chords-db.mjs` turns the package's `lib/guitar.json` into this
compact form: absolute frets, low E to high E, `x` for unplayed, dash-separated
when a fret is 10 or higher, keyed by chords-db's root and suffix names.

To update: `npm pack @tombatossals/chords-db`, unpack it, then
`node tools/build-chords-db.mjs <package>/lib/guitar.json`.

# ARC — Bend your type!

A local Figma plugin that bends a selected text layer into an arc.

- **Bend Strength** — 0% = straight, 100% = full circle. Drag it and the arc previews **live on the real Figma canvas** using the layer's actual font, size, and fills (the straight original is temporarily hidden behind the preview).
- **Preview zoom** — scales the panel sketch only (doesn't affect the canvas preview or the result).
- **Apply** — finalises the previewed arc as a grouped result placed over the original. **The original layer is kept** (toggle/hide/delete it yourself if you don't want it). ⌘Z to undo.

The panel sketch on the left is an approximation (an iframe can't access Figma's font files), so treat the **canvas** preview as the accurate one.

Runs entirely locally — `networkAccess` is `none`, no build step, no dependencies.

## How it works

Each glyph is placed on a circle of radius `R = totalWidth / Φ`, where the sweep angle `Φ = bend × 2π`. Glyphs are positioned at their cumulative baseline distance and rotated tangent to the arc via `relativeTransform`. As bend → 0, `Φ → 0` and `R → ∞`, so the line flattens.

Per-glyph splitting means complex scripts (e.g. Devanagari conjuncts) break into their component code points — same behaviour you'd get from any character-by-character arc tool.

## Install (Figma desktop)

1. Open the Figma **desktop** app.
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `manifest.json` in this folder.
4. Select a text layer, then run **Plugins → Development → ARC - Bend your type!**

## Files

- `manifest.json` — plugin manifest
- `code.js` — main thread (reads selection, performs the bend)
- `ui.html` — panel UI + live canvas preview
# arc-figma-plugin

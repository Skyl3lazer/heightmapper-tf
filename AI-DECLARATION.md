---
version: "0.1.2"
level: copilot
processes:
  design: copilot
  implementation: copilot
  testing: pair
  documentation: copilot
  deployment: copilot
components:
  export.js: copilot
  .github/workflows/pages.yml: copilot
  lib: none
  export_to_blender.py: none
  export_with_blender_script.md: none
  exporting_to_bforartists.md: none
  exporting_to_blender.md: none
  run-server.py: none
---

This format is based on [AI-DECLARATION.md](https://ai-declaration.md/en/0.1.2).

## Notes

- This is a fork of tangrams/heightmapper. The 50 upstream commits, up to 2024-07-23, predate the fork and are not covered by the evidence behind this file.
- Claude Code wrote `export.js`: elevation tile fetching, tent-filtered resampling, tile-seam healing, flat water-surface detection and the 16-bit grayscale PNG encoder.
- Claude Code rewrote the export flow in `main.js`. It removed the screenshot-stitching render and the canvas-based auto-exposure, and added the map size, ratio and orientation controls, the viewport-centered export box, the live height and water-level fields and the -100 minimum height. The upstream map, Tangram and dat.gui setup code remains.
- Claude Code switched `scene.yaml` to the AWS Terrain Tiles source and removed the Nextzen vector layers. In `index.html` it added the status panel and export box.
- Claude Code wrote `.github/workflows/pages.yml`.
- Claude Code drafted `README.md`. The author then reworded it, and the help text in `index.html` was rewritten to match the author's wording.
- The author set the requirements: the Transport Fever map sizes and the 256 px per km plus 1 rule, the -100 minimum height, the viewport-centered box and plain 16-bit grayscale without alpha.
- The author tested exports in Transport Fever 3. Those tests found the tile seams and the water-level mismatch. Claude Code checked exports with headless Chrome and independent Python decoders. Those scripts are not in the repository.
- In a contribution by ARK215, Claude Code wrote the river, relief and coast work in `export.js`, `main.js`, `overpass.js` and `towns.js`: river selection by width with a checkbox list, channel widths and depths, navigable rivers, shore shaping, the forest canopy correction, the regional base of water normalization, relief shaping, raising narrow land at the water level, state borders in the biome map and keeping towns just inside the map edge. The contributor set the requirements and tested exports of a 700 km map of Poland in Transport Fever 3. Claude Code checked the exports with node scripts that decode the PNGs. Those scripts are not in the repository.
- `lib/` holds unmodified third-party libraries. The Blender guides, `export_to_blender.py` and `run-server.py` are unchanged from upstream.

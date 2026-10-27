# Shore shaping handoff

Status on 2026-10-27, branch `shore-prototypes`. The branch adds this folder and nothing else. The app code is unchanged from `main` at b7d292e.

## Goal

Shorelines in Transport Fever 3 must not show a ledge.
In game, every shore on the London test map shows a dark step along the waterline.
The author judges shores by their shape in game, not by terrain color.
Banks should keep natural variety. A fix that gives every waterline the same slope was rejected.

## Rules from the author

- Do not commit or push unless the author asks. Never mention AI tools in commits or descriptions.
- Run one headless browser at a time. Two lock the machine.
- Water is only ever lowered when water normalization is on.
- Before reading an in-game result, check which file the game imported. `%APPDATA%\Transport Fever 3\heightmaps\` holds `london_v3.png` to `london_v6.png` from this work.
- Prototype offline on a real export first. Hand the PNG to the author for an in-game look. Port to the app only after the author approves.
- Never print or log the Overpass key in `config.js`.

Read the `heightmapper-architecture` skill and its `references/water.md` before touching water code. The `heightmapper-testing` skill covers serving, driving and checking exports.

## What is on main

`shapeShores` in `export.js` is the last export stage before `clampAndMeasure`. It also runs in `terrainPatch`, so town checks see the same terrain.

1. The water mask (`heights <= waterline`) is blurred by `SHORE_BLUR` (1 px) and cut at one half.
2. `flipSmallPatches` flips water and land patches under `MIN_SHORE_PATCH` (16 px). Flipped pixels take the mean height of their new side nearby.
3. A second blur of the cleaned mask gives each pixel its signed distance to the line through `probit`.
4. Pixels within 1 px of the line become `plane + slope * d`, with `SHORE_SLOPE` 1 in-game m per px on both sides. Water out to 4 px is kept at least one slope deep, fading out.

Approved as "MUCH stronger" in game, with "a very very slight jag in some places at some angles". The ledge complaint came after.

## What was tried

| Version | What it did | Verdict in game |
|---|---|---|
| Ramp (before `shapeShores`) | Scaled land height above the water from 15% at the shore to 100% at 3 px | Reverted. A shelf with a step at its back edge, and walled trenches in small channels |
| v3 (`refine_water.py ... sdf`) | What is on main | Approved, then "a bit of a ledge" |
| v4 (`refine_v4.py`) | Surface-net line, one slope across the line read from the land 1 to 2 px back, bed held flat until the original bed is deeper | Still a ledge. The author ruled out quay walls, since every water body has it |
| v5 (`refine_v5.py`) | Land within 8 px capped by a bank of `0.4*d + 0.1*d^2` in-game m, bed raised to mirror it for 3 px | Rejected. Every waterline gets the same slope |
| v6 (`make_v6_input.py`, then `refine_v4.py`) | Normalization's land lowering emulated at full lift at the final shoreline, then v4 | "This is leaving a ledge along every shoreline" |

It is not known whether v5 removed the ledge itself. The author rejected it for the uniform slope. Ask before building on it.

## Measurements on the London test box

### The jag

The probit line at `SHORE_BLUR` 1 keeps the mask's pixel staircase.
On synthetic straight shores (`stair_test.py`) the line wanders 0.84 px at 2 degrees, 0.5 to 0.7 px from 5 to 10 degrees, and 0.47 px at 40 degrees. A larger blur barely helps at shallow angles and loses narrow channels.

The constrained surface net (`snet.py`, `stair_test2.py`) puts one vertex in each mixed 2x2 cell and clamps it inside the cell. It then runs 100 steps of moving each vertex to its neighbors' average and 100 curvature-smoothing steps.
- Straight shores wander 0.2 px or less from 5 degrees up, and about 0.5 px at 2 degrees.
- Round lakes shrink about 0.2 px. Narrow channels and corners match the probit line.
- On London, the median waterline offset from a local fitted curve (`roughness.py`) drops from 0.095 to 0.035 px.

The author has not judged the jag fix on its own. v4 to v6 all include it.

### The ledge

`bank_compare.py` gives land height above its own water, in in-game m. "Source" uses the normalization-off export, with each body measured against its own surface.

| Median (p75 - p25) | 1 px | 2 px | 3 px | 4 px | 8 px |
|---|---|---|---|---|---|
| Source | 0.75 | 1.48 | 1.60 | 1.67 | 1.74 |
| v4 | 0.68 (0.79) | 2.56 (1.42) | 3.06 (1.84) | 3.51 (1.81) | 3.96 (1.97) |
| v5 | 0.22 (0.27) | 0.97 (0.27) | 1.59 (0.32) | 2.63 (0.48) | 3.96 (1.97) |
| v6 | 0.48 (0.59) | 1.81 (1.13) | 2.28 (1.46) | 2.90 (1.93) | 3.88 (2.06) |

Findings:
- **Normalization adds a step.** It lowered the Thames 2.16 in-game m. The land at its edge came down only 0.98 m (median), 0.63 m at 2 px, and nearly nothing from 4 px.
  - `planWater` fades the land lowering over `lift / NORMALIZE_GRADE` (`export.js`, the `offset` loop after `distanceTo(kept, ...)`).
  - It counts that distance on the coarse grid from land-cover water cells, which sit inside the final shoreline.
  - Within 8 px of water this adds a median 1.75 m and a p90 2.8 m to the bank.
- **The guard.** `applyWaterPlan` clamps lowered land to at least 1 in-game m above the water (`guard = 1 / scale`). No land on the normalized map sits within 0.75 m of the water.
- **The bed.** `layBeds` starts every unsurveyed bed at -0.9 in-game m at the first water pixel, the same on every shore. The water side then drops about 0.4 m per pixel.
- **The source.** Even the source rises 1.5 m within 2 px of the water. v6 removed most of what normalization adds and still showed a ledge in game. So either the source bank itself reads as a ledge at 4 m per pixel, or something else in the game draws it.
- **Bed dips** (`dips.py`, open water whose bed rises again farther out by more than 0.25 m): v3 0.9%, v4 1.3%, v5 0.1%, v6 0.7%. An earlier version mirrored the land slope into the water without a bed check. It had 10.5% and was dropped. The author had objected earlier to a shore that "dips weirdly".

## Suggested next steps

1. **Calibrate against the game before more prototypes.** Build a synthetic heightmap of an official size with labeled test shores.
   - Steps of 0.25, 0.5, 1 and 2 m at the waterline.
   - Straight banks of grade 0.05, 0.1, 0.2 and 0.4.
   - The v3 lip in front of a step.
   - Straight and curved shores.
   - Have the author import it and screenshot each one.

   This answers two questions: which shapes read as a ledge, and whether a perfectly gentle shore still shows the dark line. If it does, the line is the game's shore rendering and no terrain change removes it.
2. **Ask the author about v5.** Did it remove the ledge apart from the uniform slope? If yes, the open problem is variety. A bank whose steepness follows each shore's own terrain would be the direction.
3. **Keep the parts that measured better, but don't port them without approval.**
   - The surface-net line fixes the jag.
   - Lowering land from the final shoreline removes a step normalization adds. Porting it needs distance from the final lowered water at full resolution. A naive full-size distance and value grid costs about 400 MB at Gigantomaniac, so keep it to a band along the shores.
4. **A separate bug from 3579346.** With normalization off, the London box exports water level 0 and the Thames is dry at 2.16 m. Only 0.2% of the map is water.
   - A 0.05 km2 body at sea level counts as "other sea", so the tidal Thames joins the sea at 0 and nothing lowers it.
   - The other choice is level 3, which floods 26% of the map unless polders raise it.
   - The author has not decided what this case should do.

## Porting notes for the surface net

- A JavaScript version should keep a compact list of the shore vertices with neighbor indices. The numpy prototype works on full grids and takes about 7 minutes for 4097 x 4097. The JavaScript speed has not been measured.
- Keep the 0.02 px clamp margin, so no pixel center sits on the line. Every segment crosses the shared cell edge between a water and a land pixel, so pixel signs stay consistent.
- `terrainPatch` must draw the same line as the full export. Relaxation reaches about 10 to 15 vertices along the shore, inside the current `SHORE_REACH` of 32 px. Check this on Bergen with towns.

## Test box and data

London, as the author exports it:
- Very Large 1:1 landscape, center 51.5086, 0.0403. The author uses longitude 360.0403, which the driver can't set. The terrain is the same.
- 2.759 m/px, height scale 0.7939, smoothing 2.5, water normalization on, max displacement 91.
- Import values -11 / 105 / 0.

```bash
node .claude/skills/heightmapper-testing/scripts/drive.mjs --url http://localhost:8000/ --set "mapSize=Very Large" --set ratio=1:1 \
  --set orientation=landscape --set "center=51.508600, 0.040300" --set metersPerPixel=2.759 --set "scaleMode=height scale" \
  --set heightScale=0.7939 --set smoothing=2.5 --set waterNormalization=true --set normalizationLift=91 \
  --action heightmap --set fileName=london --out <dir> --timeout 1500
```

Serve the repo with `python serve11.py 8000 <heightmapper folder>`. `run-server.py` refuses concurrent connections from the driver.

Inputs the prototypes used are in the previous session's scratchpad, `C:\Users\Derek\AppData\Local\Temp\claude\c--Users-Derek-Documents-mapping\bb14d2c4-2743-4b35-a098-026c95c5b2d4\scratchpad\`. The folder may be cleaned up. Everything can be rebuilt.

| File | What | Rebuild |
|---|---|---|
| `verify\london2759\london.png` | Normalized export from before `shapeShores`. The input of every prototype | Check out 3579346 and run the command above |
| `verify\londonN\london.png` | Same box with normalization off, with `shapeShores` | Command above with `waterNormalization=false` |
| `refined\v4\B_sd.npy` | Surface-net signed distance for the London water mask | `refine_v4.py <base> <out> --line net` (7 minutes) |
| `refined\london_v3.png` to `london_v6.png` | The files given to the author | Commands below |

```bash
python -I refine_water.py <base> london_v3.png 1.0 16 16 6 0 sdf 1.0
python -I refine_v4.py <base> london_v4.png --sd-from B_sd.npy --water mirror-bed --ring 2.0 --land-hi 3.0 --reach 5
python -I refine_v5.py <base> london_v5.png --sd-from B_sd.npy
python -I make_v6_input.py <base> <unnormalized> v6_input.png
python -I refine_v4.py v6_input.png london_v6.png --sd-from B_sd.npy --water mirror-bed --ring 2.0 --land-hi 3.0 --reach 5
```

## Scripts

| Script | Purpose |
|---|---|
| `refine_water.py` | v1 to v3 prototypes. Mode `sdf` is v3 |
| `snet.py` | Constrained surface net and signed distance to it |
| `refine_v4.py` | v4 and its variants: line choice, land slope, water slope, bed shelf |
| `refine_v5.py` | v5 bank cap |
| `make_v6_input.py` | Emulates land lowering from the final shoreline using the normalized and unnormalized exports |
| `shore_metrics.py` | Waterline error against the intended line, bank profile, grades |
| `bank_compare.py` | Land height above its own water against the source, by distance |
| `dips.py` | Share of shore water whose bed rises again farther out |
| `roughness.py` | Waterline offset from a local fitted curve. `LEVEL=x` measures the contour x m above the water |
| `shore_profile.py` | Height percentiles by distance from water |
| `shade_pair.py` | Side-by-side low-sun hillshades of one window. Pixels are drawn as blocks, so it overstates jaggedness |
| `stair_test.py`, `stair_test2.py` | Synthetic straight shores, round lakes, a corner and a narrow channel, for the probit line and the surface net |
| `serve11.py` | Threaded HTTP/1.1 static server for driving exports |

All scripts read the import values from the PNG `Description` chunk. They work in real meters, where in-game meters are real times `heightScale` and the water plane is `waterLevel / heightScale`. Run them with `python -I`. They need numpy, scipy and Pillow.

/*jslint browser: true*/

// Builds a heightmap straight from terrarium elevation tiles, bypassing the WebGL canvas.
var heightmapExport = (function () {
  'use strict';

  const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const TILE_SIZE = 256;
  const MAX_ZOOM = 15;
  const EARTH_CIRCUMFERENCE = 40075016.686;
  const FETCH_ATTEMPTS = 4;
  // Real terrain stays inside these meters. Tiles sometimes hold garbage outside them, from a few pixels to a whole tile of noise.
  const PLAUSIBLE_MIN = -11500, PLAUSIBLE_MAX = 9000;
  // A tile with a larger share of bad pixels is noise throughout. All of it comes from the parent tile.
  const BAD_TILE_SHARE = 0.01;
  const PREVIEW_SIZE = 1024;
  const FLAT_TOLERANCE = 0.02;
  const MIN_WATER_CELLS = 25;
  // Share of land cover's water cells below the height taken as the lowest water, so a few misread cells can't set it.
  const LOWEST_WATER_SHARE = 0.01;
  const WATER_MERGE_METERS = 0.5;
  const BATHYMETRY_URL = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage';
  const LANDCOVER_URL = 'https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/exportImage';
  // Depth and land cover vary slowly next to the game's biome blending. They're fetched at most this many pixels across.
  const RASTER_MAX_SIZE = 2049;
  // Bytes handed to the PNG compressor at a time, which sets how often its progress is reported.
  const PNG_CHUNK = 1 << 20;
  // Impact Observatory land cover classes.
  const LC_NO_DATA = 0, LC_WATER = 1, LC_TREES = 2, LC_FLOODED = 4, LC_BARE = 8, LC_SNOW = 9, LC_CLOUDS = 10;
  // Water normalization. Smaller water bodies would pin the land around them to the water level.
  const NORMALIZE_MIN_KM2 = 0.5;
  // The steepest slope normalization adds to land in game, and the slope of the beds it lays below the shore.
  const NORMALIZE_GRADE = 0.1;
  // In-game meters. Rivers lowered by different amounts meet in a seam, which a blur this wide turns into a slope.
  const NORMALIZE_SEAM = 200;
  // In-game meters. Water normalization's regional base, the lowering land shares with the water around it, is blurred this wide.
  // Wider spreads the slope it adds between waters lowered by different amounts, but takes the least lift from farther away, which leaves each water more to fade.
  const NORMALIZE_BASE_BLUR = 150;
  // In-game meters. Land this close to kept water is its bank, which may sit below the water's smoothed surface. The fade shapes it, as it always has.
  // Capping the base by it would bring back the fade along every low bank.
  const NORMALIZE_BANK = 100;
  // Real meters a lowered surface may still sit above the level and count as water, for survey steps along a river.
  const NORMALIZE_SURFACE_TOLERANCE = 2;
  // Real meters below a water cell past which a neighbor is water below a dam, not part of its surface.
  const DAM_STEP = 3;
  // Coarse cells lowered water may reach past the cells land cover gives it, where a cell less than half water still holds the true shore.
  const LOWERED_GROWTH = 0.5;
  // Real meters below the waterline past which dry land counts as polder even where the water seems to reach it.
  const POLDER_DEPTH = 1.5;
  // Smaller enclosed low patches are hollows in tidal marsh and the like, which the water keeps.
  const POLDER_MIN_KM2 = 1;
  // Real meters from water past which low dry land counts as polder however the water reaches it. Tidal marsh lines the water closer in.
  const POLDER_INLAND = 500;
  // Output pixels a side of the pieces land cover is fetched in at twice the output's resolution, under the image service's 4000 pixel limit.
  const LOW_LAND_TILE = 1024;
  // Real meters under the waterline land cover may still show to be land. A pixel half sand spit, half sea averages about this deep.
  const LOW_LAND_DEPTH = 5;
  // Share of a pixel, weighed toward its middle, land cover must show as dry land for it to count as land. A spit a sample wide through its middle shows half,
  // a coast along its edge a quarter, and a harbour basin between quays a little more.
  const LOW_LAND_SHARE = 0.5;
  // Real meters mapped water that needs no lowering may sit above the level and still be filled. Tidal channels often survey this high.
  const LEVEL_WATER_TOLERANCE = 3;
  // Real meters above such a channel's own surface that still count as its water, which keeps its banks dry.
  const CHANNEL_SURFACE_TOLERANCE = 0.5;
  // A river's water more than this many times as wide as the river itself is a lake, reservoir, estuary or sea it runs through.
  // Its course cuts no channel there, and leaving the river out leaves that water as it is.
  const RIVER_WIDE_FACTOR = 2.5;
  // Land cover cells. Water this narrow can't be told from a river, whatever the river.
  const RIVER_WIDE_MIN_RADIUS = 2;
  // Times its own width a river's water reaches from its course, through the water, when water belongs to the river nearest it.
  const RIVER_REACH_FACTOR = 1.25;
  // Share of a river course's land cover cells that must be water for land cover to measure the river.
  const RIVER_MEASURED_SHARE = 0.5;
  // Times as long as it is wide a river's water must run along its course for land cover to measure it. A course across a lake runs about as far as the lake is wide.
  const RIVER_MEASURED_ELONGATION = 10;
  // Land cover cells across a river must be for land cover to measure it. Narrower rivers come out a whole cell or two wide, whatever their width.
  const RIVER_MEASURED_MIN_CELLS = 3;
  // Land cover cells a river course drawn beside its water may cross to reach it.
  const RIVER_LAND_STEPS = 2;
  // Pixels. The widest channel's half width.
  const RIVER_MAX_HALF_WIDTH = 127.5;
  // In-game meters per pixel a channel's bed falls from its bank until it reaches its full depth.
  const RIVER_EDGE_SLOPE = 2;
  // Pixels over which a channel narrows and gets shallower toward its end, down to this share of its width and depth.
  const RIVER_TAPER = 25, RIVER_TAPER_MIN = 0.25;
  // Pixels from a course's end within which another course joins it, so its channel goes on.
  const RIVER_END_REACH = 1.5;
  // Pixels from the planned water over which land blends from the shore slope into the terrain, and how far into the water the shore slope reaches.
  const SHORE_BAND = 3, SHORE_WATER_REACH = 1.5;
  // In-game meters per pixel water deepens from the shore.
  const SHORE_WATER_SLOPE = 2;
  // Pixels. A shore is never placed nearer a land pixel's centre than this, which keeps land above the water.
  const SHORE_MIN_LAND = 0.25;
  // Pixels. Smaller patches of water away from mapped water and channels are pits, not water.
  const SPECK_PIXELS = 10;
  // Pixels. Channel land too high to cut, with the channel's water this near on both sides, like an embankment across the river, is cut through.
  const RIVER_BREACH = 3;
  // Real meters above the water level. A navigable river gets its navigable width where it runs this low, and its own width again NAVIGABLE_FADE higher,
  // so it widens for ships in the lowlands without flooding the mountain valleys it rises in.
  const NAVIGABLE_ELEVATION = 250, NAVIGABLE_FADE = 100;
  // A selected river's course is smoothed along its length over this share of its channel's width.
  const RIVER_COURSE_SMOOTHING = 0.75;
  // Eighths of a pixel. A channel's edge distance starts this far everywhere, past any channel's reach.
  const BAND_FAR = 32000;
  // Pixels around a grid whose channels still reach into it.
  const BAND_MAX_MARGIN = 512;
  // Real meters a river line may still sit above the level after lowering and be cut. A line drawn up a valley wall would cut a gash.
  const RIVER_LINE_TOLERANCE = 15;
  // The in-game slope the land beside a cut river channel may rise at, so its banks slope instead of standing as walls.
  const RIVER_BANK_GRADE = 0.5;
  // In-game meters.
  const BED_MAX_DEPTH = 10;
  // Share of a water body NOAA must give real depths for before its very shallow spots count as real shallows rather than missing data.
  const SURVEYED_SHARE = 0.2;
  // Rows of a full-size grid between progress reports, each a moment the page can repaint.
  const ROW_BATCH = 256;
  // Forest canopy. The elevation tiles are a surface model, so woods stand above the fields beside them, with a sharp step at every forest edge.
  // Real meters. The canopy height fitted per export is kept within CANOPY_MAX. Below CANOPY_MIN the tiles show bare ground, as lidar does, and nothing is lowered.
  const CANOPY_MIN = 1, CANOPY_MAX = 15;
  // Real meters taken as the canopy where no forest edge on gentle land measures it. Fewer than CANOPY_MIN_EDGES edges can only lower it.
  const CANOPY_DEFAULT = 7, CANOPY_MIN_EDGES = 200;
  // Real degrees. Land this gentle measures the canopy and loses all of it. The lowering fades out by CANOPY_STEEP, where the relief dwarfs the canopy.
  const CANOPY_FLAT = 3, CANOPY_STEEP = 6;
  // Real meters. Slopes are taken over this much ground, so that a forest's own edge doesn't read as a slope.
  const CANOPY_SLOPE_METERS = 300;
  // Output pixels and real meters. A forest's edge is feathered over the wider of the two, about as far as the tiles and land cover's cells blur it.
  const CANOPY_FEATHER = 2, CANOPY_FEATHER_METERS = 20;
  // Real meters past a forest's edge where the tiles show its full height and the open land its own, for measuring the step between them.
  const CANOPY_EDGE_METERS = 150;
  // Land cover cells. The tiles' step sits up to half a cell from where the cells put the edge, which no feather can follow.
  // The land around forest edges is blurred with a sigma of this share of a cell, which turns what step is left into a slope.
  const CANOPY_EDGE_BLUR = 0.75;
  // Relief shaping. Pixels of the blur that splits land into a base and the detail on it, about 2 km at 98 real m per pixel.
  // The base keeps the shape of valleys and ranges. Only the detail on it is scaled.
  const RELIEF_SIGMA = 20;
  // How many times taller the detail of flat land gets. Flat land at small height scales otherwise reads as a table in game.
  const RELIEF_GAIN = 2.5;
  // In-game meters. Rough land's detail is scaled toward this root mean square height, however rough it is, so mountains don't turn into needles.
  const RELIEF_MOUNTAIN = 12;
  // Pixels from water over which the gain fades in. Shores and normalization's ramps keep the shape they were given.
  const RELIEF_WATER_FADE = 10;
  // The blur's sigma in pooled cells. At the default sigma the cells are 5 pixels a side, and the nine grids of land moments
  // take 1.4 bytes per output pixel. Below a sigma of 16 they outgrow a full-size Float32Array.
  const RELIEF_CELL_SIGMA = 4;
  // Share of the blur's variance added to the land's spread when fitting the base's plane. A thin strip of land can't tilt it across itself.
  const RELIEF_RIDGE = 0.1;
  // Transport Fever 3 writes biomes 0 to 4 as these gray levels.
  const BIOME_GRAY = [0, 63, 127, 191, 255];
  const GAME_METERS_PER_PIXEL = 4;
  // Real-world slopes in degrees. The game's horizontal squeeze would make gentle land read as hills.
  const HILL_SLOPE = 10, MOUNTAIN_BIOME_SLOPE = 25, MOUNTAIN_MASK_SLOPE = 20;
  // In-game meters.
  const RIVER_MAX_WIDTH = 280;
  // In-game meters state borders are drawn wide by default, and the biome they're drawn in. The game only paints its masks near water or on slopes,
  // and blends biomes, so the strip shows only as the hills biome's drier grass and only this wide.
  const BORDER_WIDTH = 64, BORDER_BIOME = 3;
  // Real meters. Coast hills are land near the sea where this share of the land within HILL_AREA_RADIUS is steeper than HILL_SLOPE.
  const COAST_HILLS_DISTANCE = 15000, HILL_AREA_RADIUS = 500, HILL_AREA_SHARE = 0.3;
  // Real meters. The game's volcano covers the whole cone. Each OpenStreetMap volcano spreads down the hill slopes around it.
  const SUMMIT_SEARCH_RADIUS = 1000, VOLCANO_SEED_RADIUS = 600, VOLCANO_RADIUS = 10000;
  // Mesas and buttes are land ringed by cliffs steeper than CLIFF_SLOPE degrees, with a summit TABLELAND_MIN_RELIEF real meters above the highest point of its foot.
  const CLIFF_SLOPE = 45, TABLELAND_MIN_RELIEF = 30;
  // Real meters. Closes gaps in a cliff ring up to twice this wide.
  const CLIFF_GAP = 30;
  // Real meters. A formation takes in the slopes this close to it.
  const TABLELAND_APRON = 100;
  // Square kilometers. Formations under MESA_MIN_KM2 are buttes. Formations over TABLELAND_MAX_KM2 are plateaus.
  const TABLELAND_MIN_KM2 = 0.005, MESA_MIN_KM2 = 0.5, TABLELAND_MAX_KM2 = 25;
  // Buttes make a monument valley only in groups of MONUMENT_MIN_BUTTES, each within MONUMENT_RADIUS real meters of the next.
  const MONUMENT_RADIUS = 2000, MONUMENT_MIN_BUTTES = 3;
  // The masks each climate's biome import reads.
  const CLIMATE_LAYERS = {
    Temperate: ['mountains', 'rivers'],
    Dry: ['coast_hills', 'mesas', 'monument_valley', 'mountains', 'rivers'],
    Tropical: ['islands', 'mountains', 'volcano'],
    Subarctic: ['lakes', 'mountains', 'swamps']
  };
  const SEAM_FEATHER = 32;
  const SEAM_MEDIAN_RADIUS = 7;
  const SEAM_MIN_STEP = 0.1;
  // Survey mismatches are a few meters. Larger steps come from bad tile pixels, which healing would smear across the next 32 rows.
  const SEAM_MAX_STEP = 30;

  function lngToX(lng) {
    return (lng + 180) / 360;
  }

  function latToY(lat) {
    const rad = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  }

  function xToLng(x) {
    return x * 360 - 180;
  }

  function yToLat(y) {
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
  }

  // Lowest zoom giving at least `oversample` source pixels per output pixel.
  function pickZoom(spanX, width, oversample) {
    const zoom = Math.ceil(Math.log2(oversample * (width - 1) / (spanX * TILE_SIZE)));
    return Math.min(MAX_ZOOM, Math.max(0, zoom));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Lets the page repaint during long computations. A timer would be held to once a second in a background tab.
  function yieldToPage() {
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }

  async function fetchTile(z, x, y) {
    return repairTile(await downloadTile(z, x, y), z, x, y);
  }

  function plausible(h) {
    return h >= PLAUSIBLE_MIN && h <= PLAUSIBLE_MAX;
  }

  async function repairTile(heights, z, x, y) {
    let bad = 0;
    for (let i = 0; i < heights.length; i++) if (!plausible(heights[i])) bad++;
    if (!bad || z === 0) return heights;
    const parent = await fetchTile(z - 1, x >> 1, y >> 1);
    const whole = bad > BAD_TILE_SHARE * heights.length;
    const half = TILE_SIZE / 2, ox = (x & 1) * half, oy = (y & 1) * half;
    for (let r = 0; r < TILE_SIZE; r++) {
      const v = Math.min(Math.max(oy + (r + 0.5) / 2 - 0.5, 0), TILE_SIZE - 1);
      const r0 = Math.min(Math.floor(v), TILE_SIZE - 2), fy = v - r0;
      for (let c = 0; c < TILE_SIZE; c++) {
        const i = r * TILE_SIZE + c;
        if (!whole && plausible(heights[i])) continue;
        const u = Math.min(Math.max(ox + (c + 0.5) / 2 - 0.5, 0), TILE_SIZE - 1);
        const c0 = Math.min(Math.floor(u), TILE_SIZE - 2), fx = u - c0;
        const p = r0 * TILE_SIZE + c0;
        const upper = parent[p] + (parent[p + 1] - parent[p]) * fx;
        const lower = parent[p + TILE_SIZE] + (parent[p + TILE_SIZE + 1] - parent[p + TILE_SIZE]) * fx;
        heights[i] = upper + (lower - upper) * fy;
      }
    }
    return heights;
  }

  async function downloadTile(z, x, y) {
    const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    let lastError;
    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** attempt);
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await decodeTile(await response.blob());
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(`Tile ${z}/${x}/${y} failed after ${FETCH_ATTEMPTS} attempts: ${lastError.message}`);
  }

  async function decodeTile(blob) {
    const bitmap = await createImageBitmap(blob, {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    const heights = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let i = 0; i < heights.length; i++) {
      heights[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
    }
    return heights;
  }

  // Neighboring tiles were sometimes built from different surveys, leaving a straight step along their shared edge.
  // The median along the edge keeps features that cross it from counting as a step.
  function healSeam(a, indexA, b, indexB, length) {
    const step = new Float32Array(length);
    for (let p = 0; p < length; p++) {
      const a0 = a[indexA(p, 0)], a1 = a[indexA(p, 1)], b0 = b[indexB(p, 0)], b1 = b[indexB(p, 1)];
      step[p] = (b0 - a0) - ((a0 - a1) + (b1 - b0)) / 2;
    }
    for (let p = 0; p < length; p++) {
      const near = Array.from(step.subarray(Math.max(0, p - SEAM_MEDIAN_RADIUS), Math.min(length, p + SEAM_MEDIAN_RADIUS + 1)));
      near.sort((x, y) => x - y);
      const offset = near[near.length >> 1];
      if (Math.abs(offset) < SEAM_MIN_STEP || Math.abs(offset) > SEAM_MAX_STEP) continue;
      for (let k = 0; k < SEAM_FEATHER; k++) {
        const share = offset / 2 * (1 - k / SEAM_FEATHER);
        a[indexA(p, k)] += share;
        b[indexB(p, k)] -= share;
      }
    }
  }

  async function fetchStrip(z, ty, tx0, tx1) {
    const columns = tx1 - tx0 + 1;
    const stripWidth = columns * TILE_SIZE;
    const strip = new Float32Array(stripWidth * TILE_SIZE);
    const tiles = [];
    // Columns past the antimeridian come from the other side of the world.
    for (let tx = tx0; tx <= tx1; tx++) tiles.push(fetchTile(z, ((tx % 2 ** z) + 2 ** z) % 2 ** z, ty));
    (await Promise.all(tiles)).forEach((tile, c) => {
      for (let row = 0; row < TILE_SIZE; row++) {
        strip.set(tile.subarray(row * TILE_SIZE, (row + 1) * TILE_SIZE), row * stripWidth + c * TILE_SIZE);
      }
    });
    for (let edge = TILE_SIZE; edge < stripWidth; edge += TILE_SIZE) {
      healSeam(strip, (row, k) => row * stripWidth + edge - 1 - k, strip, (row, k) => row * stripWidth + edge + k, TILE_SIZE);
    }
    return strip;
  }

  // Source pixels and tent-filter weights for each output sample, as flat arrays indexed through offsets.
  // wrap: the axis carries on past its edges, as longitude does around the world.
  function footprints(start, end, count, scale, wrap) {
    const radius = Math.max((end - start) * scale / (count - 1), 1);
    const offsets = new Int32Array(count + 1);
    const index = [], weight = [];
    for (let i = 0; i < count; i++) {
      const center = (start + i / (count - 1) * (end - start)) * scale;
      const first = wrap ? Math.ceil(center - radius - 0.5) : Math.max(0, Math.ceil(center - radius - 0.5));
      const last = wrap ? Math.floor(center + radius - 0.5) : Math.min(scale - 1, Math.floor(center + radius - 0.5));
      const from = index.length;
      let total = 0;
      for (let k = first; k <= last; k++) {
        const w = 1 - Math.abs(k + 0.5 - center) / radius;
        if (w > 0) {
          index.push(k);
          weight.push(w);
          total += w;
        }
      }
      for (let t = from; t < index.length; t++) weight[t] /= total;
      offsets[i + 1] = index.length;
    }
    return {offsets: offsets, index: Int32Array.from(index), weight: Float32Array.from(weight)};
  }

  // Filters the source so every output pixel is smoothed alike. Point or box sampling near whole ratios leaves bands.
  // Samples sit on a grid whose first and last pixels are on the region edges.
  async function sampleRegion(region, width, height, zoom, onProgress) {
    const scale = TILE_SIZE * 2 ** zoom;
    const cols = footprints(region.x0, region.x1, width, scale, true);
    const rows = footprints(region.y0, region.y1, height, scale);
    const tx0 = Math.floor(cols.index[0] / TILE_SIZE);
    const tx1 = Math.floor(cols.index[cols.index.length - 1] / TILE_SIZE);
    const ty0 = Math.floor(rows.index[0] / TILE_SIZE);
    const ty1 = Math.floor(rows.index[rows.index.length - 1] / TILE_SIZE);
    const stripWidth = (tx1 - tx0 + 1) * TILE_SIZE;
    for (let t = 0; t < cols.index.length; t++) cols.index[t] -= tx0 * TILE_SIZE;

    const strips = new Map();
    let stripsDone = 0;
    function strip(ty) {
      if (!strips.has(ty)) {
        strips.set(ty, fetchStrip(zoom, ty, tx0, tx1).then(s => {
          onProgress(++stripsDone / (ty1 - ty0 + 1));
          return s;
        }));
      }
      return strips.get(ty);
    }

    const healed = new Set();
    async function healBelow(ty) {
      if (healed.has(ty) || ty >= ty1) return;
      healed.add(ty);
      const upper = await strip(ty), lower = await strip(ty + 1);
      healSeam(upper, (x, k) => (TILE_SIZE - 1 - k) * stripWidth + x, lower, (x, k) => k * stripWidth + x, stripWidth);
    }

    const filtered = new Map();
    async function filteredRow(iy) {
      if (!filtered.has(iy)) {
        const ty = Math.floor(iy / TILE_SIZE), r = iy % TILE_SIZE;
        if (r >= TILE_SIZE - SEAM_FEATHER) await healBelow(ty);
        if (r < SEAM_FEATHER && ty > ty0) await healBelow(ty - 1);
        const s = await strip(ty);
        const offset = (iy % TILE_SIZE) * stripWidth;
        const row = new Float32Array(width);
        for (let i = 0; i < width; i++) {
          let v = 0;
          for (let t = cols.offsets[i]; t < cols.offsets[i + 1]; t++) v += cols.weight[t] * s[offset + cols.index[t]];
          row[i] = v;
        }
        filtered.set(iy, row);
      }
      return filtered.get(iy);
    }

    const out = new Float32Array(width * height);
    for (let j = 0; j < height; j++) {
      const first = rows.index[rows.offsets[j]];
      const ty = Math.floor(first / TILE_SIZE);
      for (const old of strips.keys()) if (old < ty) strips.delete(old);
      for (const old of filtered.keys()) if (old < first) filtered.delete(old);
      if (ty + 1 <= ty1) strip(ty + 1);

      const base = j * width;
      for (let t = rows.offsets[j]; t < rows.offsets[j + 1]; t++) {
        const row = await filteredRow(rows.index[t]);
        const w = rows.weight[t];
        for (let i = 0; i < width; i++) out[base + i] += w * row[i];
      }
    }
    return out;
  }

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  }());

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function pngChunk(type, data) {
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
  }

  // Stored, uncompressed ZIP. The PNGs inside are already compressed. Deflating them again would gain little.
  // onProgress(fraction): called as the files are read.
  async function makeZip(files, onProgress) {
    onProgress = onProgress || function () {};
    const total = files.reduce((n, file) => n + file.blob.size, 0);
    let done = 0;
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const file of files) {
      const name = new TextEncoder().encode(file.path);
      const size = file.blob.size;
      const crc = crc32(new Uint8Array(await file.blob.arrayBuffer()));
      done += size;
      onProgress(done / total);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      parts.push(local, name, file.blob);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(12, time, true);
      entry.setUint16(14, date, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, size, true);
      entry.setUint32(24, size, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);
      central.push(entry, name);
      offset += 30 + name.length + size;
    }
    const centralSize = central.reduce((n, part) => n + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end]), {type: 'application/zip'});
  }

  // onProgress(fraction): called as the image data goes into the compressor.
  async function encodeGrayPng(samples, width, height, bitDepth, text, onProgress) {
    const bytesPerSample = bitDepth / 8;
    const stride = 1 + width * bytesPerSample;
    const raw = new Uint8Array(stride * height);
    const scanline = new Uint8Array(width * bytesPerSample);
    const previous = new Uint8Array(width * bytesPerSample);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const v = samples[j * width + i];
        if (bitDepth === 16) {
          scanline[i * 2] = v >> 8;
          scanline[i * 2 + 1] = v & 0xFF;
        } else {
          scanline[i] = v;
        }
      }
      // PNG "Up" filter: smooth terrain compresses far better as row deltas.
      const offset = j * stride;
      raw[offset] = 2;
      for (let k = 0; k < scanline.length; k++) raw[offset + 1 + k] = scanline[k] - previous[k];
      previous.set(scanline);
    }

    let fed = 0;
    const source = new ReadableStream({
      async pull(controller) {
        if (fed >= raw.length) {
          controller.close();
          return;
        }
        controller.enqueue(raw.subarray(fed, fed + PNG_CHUNK));
        fed = Math.min(raw.length, fed + PNG_CHUNK);
        if (onProgress) onProgress(fed / raw.length);
        await yieldToPage();
      }
    });
    const idat = new Uint8Array(await new Response(source.pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, width);
    ihdrView.setUint32(4, height);
    ihdr[8] = bitDepth;
    ihdr[9] = 0;

    const parts = [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), pngChunk('IHDR', ihdr)];
    for (const key of Object.keys(text)) {
      parts.push(pngChunk('tEXt', new TextEncoder().encode(key + '\0' + text[key])));
    }
    parts.push(pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0)));
    return new Blob(parts, {type: 'image/png'});
  }

  function boundsToRegion(bounds) {
    return {x0: lngToX(bounds.west), x1: lngToX(bounds.east), y0: latToY(bounds.north), y1: latToY(bounds.south)};
  }

  // Ground meters across the region, measured at its center latitude.
  function groundWidth(region) {
    const centerLat = yToLat((region.y0 + region.y1) / 2);
    return (region.x1 - region.x0) * EARTH_CIRCUMFERENCE * Math.cos(centerLat * Math.PI / 180);
  }

  // Real m2 of one cell in each row of a grid over the region. Web Mercator stretches the ground away from the equator. Cells near the poles cover less.
  function rowAreas(region, width, height) {
    const equator = (region.x1 - region.x0) * EARTH_CIRCUMFERENCE / (width - 1), areas = new Float64Array(height);
    for (let y = 0; y < height; y++) {
      areas[y] = (equator * Math.cos(yToLat(region.y0 + y / (height - 1) * (region.y1 - region.y0)) * Math.PI / 180)) ** 2;
    }
    return areas;
  }

  // Hydro-flattened lakes and seas are stored as large, perfectly level areas.
  // areas: as rowAreas gives. floor, ceiling: the clamp levels, whose cells are flat only because they were clamped. cover: land cover classes, or null.
  function findWaterSurfaces(heights, width, height, areas, floor, ceiling, cover) {
    // Clamped cells hold the limits rounded to 32 bits, which a 64-bit comparison would count as inside them.
    floor = Math.fround(floor);
    ceiling = Math.fround(ceiling);
    const level = (i, j) => Math.abs(heights[i] - heights[j]) < FLAT_TOLERANCE;
    const flat = new Uint8Array(heights.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const flatX = (x > 0 && level(i, i - 1)) || (x < width - 1 && level(i, i + 1));
        const flatY = (y > 0 && level(i, i - width)) || (y < height - 1 && level(i, i + width));
        flat[i] = flatX && flatY && heights[i] > floor && heights[i] < ceiling ? 1 : 0;
      }
    }

    const surfaces = [];
    const queue = new Int32Array(heights.length);
    const claimed = new Uint8Array(heights.length);
    for (let start = 0; start < heights.length; start++) {
      if (!flat[start]) continue;
      flat[start] = 0;
      let head = 0, tail = 0, sum = 0, top = -Infinity, area = 0;
      queue[tail++] = start;
      while (head < tail) {
        const i = queue[head++];
        sum += heights[i];
        area += areas[(i / width) | 0];
        top = Math.max(top, heights[i]);
        const x = i % width;
        for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
          if (j >= 0 && j < heights.length && flat[j] && level(i, j)) {
            flat[j] = 0;
            queue[tail++] = j;
          }
        }
      }
      if (tail >= MIN_WATER_CELLS) {
        surfaces.push({level: sum / tail, top: top, area: area});
        for (let q = 0; q < tail; q++) claimed[queue[q]] = 1;
      }
    }

    // Land cover keeps dry land below sea level from counting as water. It has no data over open ocean, where height decides.
    const isWater = i => cover && cover[i] !== LC_NO_DATA && cover[i] !== LC_CLOUDS ? cover[i] === LC_WATER : heights[i] <= 0;

    // Open sea has real depth. It never shows up as a flat surface. Other water at or below sea level counts as sea.
    let seaCells = 0, seaArea = 0;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] <= 0 && !claimed[i] && isWater(i)) {
        seaCells++;
        seaArea += areas[(i / width) | 0];
      }
    }
    if (seaCells >= MIN_WATER_CELLS) surfaces.push({level: 0, top: 0, area: seaArea, sea: true});

    surfaces.sort((a, b) => a.level - b.level);
    const merged = [];
    for (const surface of surfaces) {
      const last = merged[merged.length - 1];
      if (last && surface.level - last.base < WATER_MERGE_METERS) {
        last.top = Math.max(last.top, surface.top);
        last.area += surface.area;
        last.sea = last.sea || surface.sea;
      } else {
        merged.push({base: surface.level, top: surface.top, area: surface.area, sea: surface.sea});
      }
    }
    // On a map without sea, the lowest water land cover sees outside flat lakes, like a river leaving the map, can set the level for water normalization to lower the rest onto.
    if (!merged.some(m => m.sea) && cover) {
      const mapped = [];
      let mappedArea = 0;
      for (let i = 0; i < heights.length; i++) {
        if (cover[i] !== LC_WATER || claimed[i]) continue;
        mapped.push(heights[i]);
        mappedArea += areas[(i / width) | 0];
      }
      if (mapped.length >= MIN_WATER_CELLS) {
        const low = Float32Array.from(mapped).sort()[Math.floor(mapped.length * LOWEST_WATER_SHARE)];
        merged.push({base: low, top: low, area: mappedArea, river: true});
      }
    }
    // Dry land, sorted, so the share a water level would drown is a binary search.
    const dry = [];
    for (let i = 0; i < heights.length; i++) {
      if (!claimed[i] && !isWater(i)) dry.push(heights[i]);
    }
    const drySorted = Float32Array.from(dry).sort();
    function floodShare(level) {
      let lo = 0, hi = drySorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (drySorted[mid] <= level) lo = mid + 1;
        else hi = mid;
      }
      return lo / heights.length;
    }
    return {
      surfaces: merged
        .map(m => ({level: m.base, top: m.top, areaKm2: m.area / 1e6, sea: Boolean(m.sea), river: Boolean(m.river)}))
        .sort((a, b) => b.areaKm2 - a.areaKm2),
      floodShare: floodShare
    };
  }

  // ArcGIS image services return no data past the antimeridian. A box crossing it is fetched in pieces, each shifted back into the world.
  // onProgress(fraction): called as the image downloads. The server's own preparation time can't be measured.
  async function fetchImageServer(url, region, width, height, pixelType, interpolation, onProgress) {
    const out = new (pixelType === 'F32' ? Float32Array : Uint8Array)(width * height);
    const cell = (region.x1 - region.x0) / (width - 1);
    for (let c = 0; c < width;) {
      const world = Math.floor(region.x0 + c * cell);
      let end = c;
      while (end + 1 < width && Math.floor(region.x0 + (end + 1) * cell) === world) end++;
      const columns = end - c + 1;
      const before = c;
      const piece = await fetchImagePiece(url, region.x0 + c * cell - world, columns, cell, region, height, pixelType, interpolation,
        f => { if (onProgress) onProgress((before + f * columns) / width); });
      for (let r = 0; r < height; r++) out.set(piece.subarray(r * columns, (r + 1) * columns), r * width + c);
      c = end + 1;
    }
    return out;
  }

  // Columns from normalized x0, cell apart, all inside one copy of the world.
  // ArcGIS image services return raw pixels on exactly our grid when asked for band-sequential Web Mercator output.
  async function fetchImagePiece(url, x0, width, cell, region, height, pixelType, interpolation, onProgress) {
    const span = 2 * Math.PI * 6378137;
    const dx = cell * span, dy = (region.y1 - region.y0) * span / (height - 1);
    const west = (x0 - 0.5) * span - dx / 2, east = (x0 + (width - 1) * cell - 0.5) * span + dx / 2;
    const south = (0.5 - region.y1) * span - dy / 2, north = (0.5 - region.y0) * span + dy / 2;
    const params = new URLSearchParams({
      bbox: [west, south, east, north].join(','), bboxSR: 3857, imageSR: 3857, size: width + ',' + height,
      format: 'bsq', pixelType: pixelType, interpolation: interpolation, f: 'image',
      // Marks missing depths as impossible values instead of 0, which would read as sea level.
      noData: pixelType === 'F32' ? PLAUSIBLE_MIN * 10 : 0
    });
    const response = await fetch(url + '?' + params, {signal: AbortSignal.timeout(120000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const floats = pixelType === 'F32';
    const expected = width * height * (floats ? 4 : 1), bytes = new Uint8Array(expected);
    let received = 0;
    for (const reader = response.body.getReader();;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (received < expected) bytes.set(value.subarray(0, expected - received), received);
      received += value.length;
      onProgress(Math.min(1, received / expected));
    }
    if (received < expected) throw new Error('short response');
    return floats ? new Float32Array(bytes.buffer) : bytes;
  }

  function rasterSize(width, height) {
    const scale = Math.min(1, (RASTER_MAX_SIZE - 1) / (Math.max(width, height) - 1));
    return {width: Math.max(2, Math.round((width - 1) * scale) + 1), height: Math.max(2, Math.round((height - 1) * scale) + 1)};
  }

  // NOAA has no data within a few kilometers of the antimeridian.
  function fillGaps(grid, width, height, reach) {
    for (let r = 0; r < height; r++) {
      const row = r * width;
      for (let c = 0; c < width; c++) {
        if (plausible(grid[row + c])) continue;
        for (let d = 1; d <= reach; d++) {
          if (c - d >= 0 && plausible(grid[row + c - d])) {
            grid[row + c] = grid[row + c - d];
            break;
          }
          if (c + d < width && plausible(grid[row + c + d])) {
            grid[row + c] = grid[row + c + d];
            break;
          }
        }
      }
    }
  }

  // Cells at or below submerge.level take NOAA depths. Every one ends at or below submerge.top so it sits under the water.
  // lowered: optional, cells water normalization lowered. Their NOAA values describe the old height. They are left for layBeds.
  // Returns a note, and on NOAA's grid the water bodies it surveyed, as {grid, width, height}, or null.
  async function applyBathymetry(heights, width, height, region, submerge, onProgress, lowered) {
    const {level, top} = submerge;
    if (!heights.some(h => h <= level)) return {note: 'no water below the water level', surveyed: null};
    const {width: bw, height: bh} = rasterSize(width, height);
    let depth = null, note = 'NOAA water depths applied';
    try {
      depth = await fetchImageServer(BATHYMETRY_URL, region, bw, bh, 'F32', 'RSP_BilinearInterpolation', onProgress);
      fillGaps(depth, bw, bh, 8);
    } catch (e) {
      note = 'NOAA water depths unavailable (' + e.message + ')';
    }
    const fx = (bw - 1) / (width - 1), fy = (bh - 1) / (height - 1);
    for (let j = 0; j < height; j++) {
      const v = j * fy, r = Math.min(Math.floor(v), bh - 2), ty = v - r;
      for (let i = 0; i < width; i++) {
        const k = j * width + i;
        if (heights[k] > level || (lowered && lowered[k])) continue;
        let d = NaN;
        if (depth) {
          const u = i * fx, c = Math.min(Math.floor(u), bw - 2), tx = u - c;
          const upper = depth[r * bw + c] + (depth[r * bw + c + 1] - depth[r * bw + c]) * tx;
          const lower = depth[(r + 1) * bw + c] + (depth[(r + 1) * bw + c + 1] - depth[(r + 1) * bw + c]) * tx;
          d = upper + (lower - upper) * ty;
        }
        heights[k] = Math.min(plausible(d) ? d : heights[k], top);
      }
    }
    return {note: note, surveyed: depth ? surveyedWater(heights, width, height, depth, bw, bh, level, top) : null};
  }

  // NOAA repeats the surface of water it has no survey of, like most lakes, which would otherwise read as very shallow water.
  function surveyedWater(heights, width, height, depth, bw, bh, level, top) {
    const water = new Uint8Array(bw * bh);
    for (let j = 0; j < bh; j++) {
      const row = Math.round(j * (height - 1) / (bh - 1)) * width;
      for (let i = 0; i < bw; i++) if (heights[row + Math.round(i * (width - 1) / (bw - 1))] <= level) water[j * bw + i] = 1;
    }
    const {labels, count} = label(water, bw, bh);
    const cells = new Float64Array(count + 1), measured = new Float64Array(count + 1);
    for (let i = 0; i < bw * bh; i++) {
      if (!labels[i]) continue;
      cells[labels[i]]++;
      if (plausible(depth[i]) && depth[i] < top) measured[labels[i]]++;
    }
    const grid = new Uint8Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) if (labels[i] && measured[labels[i]] >= SURVEYED_SHARE * cells[labels[i]]) grid[i] = 1;
    return {grid: grid, width: bw, height: bh};
  }

  // Half-width r and edge share of three box passes that together blur with a standard deviation of sigma pixels.
  // The share lets the blur grow smoothly instead of a whole pixel at a time.
  function boxKernel(sigma) {
    const r = Math.floor((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2);
    const v = sigma * sigma / 3, a = r * (r + 1) * (2 * r + 1) / 3, b = 2 * r + 1;
    return {r: r, share: (v * b - a) / (2 * (r + 1) * (r + 1) - 2 * v)};
  }

  // A Gaussian-like blur of the land, sigma in pixels. Water at or below level is left out so that no shoreline moves.
  // onProgress(fraction): called after each pass, and awaited.
  async function smoothLand(heights, width, height, sigma, level, onProgress) {
    if (!(sigma > 0)) return;
    const {r, share} = boxKernel(sigma);
    const sum = new Float32Array(heights.length), weight = new Float32Array(heights.length);
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] > level) {
        sum[i] = heights[i];
        weight[i] = 1;
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      boxSum(sum, width, height, r, share);
      if (onProgress) await onProgress((2 * pass + 1) / 6);
      boxSum(weight, width, height, r, share);
      if (onProgress) await onProgress((2 * pass + 2) / 6);
    }
    for (let i = 0; i < heights.length; i++) if (heights[i] > level) heights[i] = sum[i] / weight[i];
  }

  // Replaces each cell with the sum over the square of half-width r around it. Columns go in blocks to stay in cache.
  function boxSum(grid, width, height, r, share) {
    const line = new Float64Array(width + 1);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) line[x + 1] = line[x] + grid[row + x];
      for (let x = 0; x < width; x++) {
        const inner = line[Math.min(x + r, width - 1) + 1] - line[Math.max(x - r, 0)];
        grid[row + x] = inner + share * (line[Math.min(x + r + 1, width - 1) + 1] - line[Math.max(x - r - 1, 0)] - inner);
      }
    }
    const block = 32, sums = new Float64Array(block * (height + 1));
    for (let x0 = 0; x0 < width; x0 += block) {
      const span = Math.min(block, width - x0);
      for (let y = 0; y < height; y++) {
        const row = y * width + x0, from = y * block, to = from + block;
        for (let b = 0; b < span; b++) sums[to + b] = sums[from + b] + grid[row + b];
      }
      for (let y = 0; y < height; y++) {
        const row = y * width + x0, hi = (Math.min(y + r, height - 1) + 1) * block, lo = Math.max(y - r, 0) * block;
        const outerHi = (Math.min(y + r + 1, height - 1) + 1) * block, outerLo = Math.max(y - r - 1, 0) * block;
        for (let b = 0; b < span; b++) {
          const inner = sums[hi + b] - sums[lo + b];
          grid[row + b] = inner + share * (sums[outerHi + b] - sums[outerLo + b] - inner);
        }
      }
    }
  }

  function highest(heights) {
    let peak = -Infinity;
    for (let i = 0; i < heights.length; i++) peak = Math.max(peak, heights[i]);
    return peak;
  }

  function clampAndMeasure(heights, floor, ceiling) {
    let lo = Infinity, hi = -Infinity, capped = 0;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] < floor) heights[i] = floor;
      if (heights[i] > ceiling) {
        heights[i] = ceiling;
        capped++;
      }
      lo = Math.min(lo, heights[i]);
      hi = Math.max(hi, heights[i]);
    }
    return {lo: lo, hi: hi, capped: capped};
  }

  // Two-pass chamfer distance, in cells, from every cell to the nearest one where source is set.
  // values: optional, rewritten in place so every cell holds the value of the source cell nearest it.
  function distanceTo(source, width, height, values) {
    const d = new Float32Array(width * height);
    for (let i = 0; i < d.length; i++) d[i] = source[i] ? 0 : Infinity;
    const relax = (i, j, step) => {
      if (d[j] + step < d[i]) {
        d[i] = d[j] + step;
        if (values) values[i] = values[j];
      }
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (x > 0) relax(i, i - 1, 1);
        if (y > 0) {
          relax(i, i - width, 1);
          if (x > 0) relax(i, i - width - 1, Math.SQRT2);
          if (x < width - 1) relax(i, i - width + 1, Math.SQRT2);
        }
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const i = y * width + x;
        if (x < width - 1) relax(i, i + 1, 1);
        if (y < height - 1) {
          relax(i, i + width, 1);
          if (x < width - 1) relax(i, i + width + 1, Math.SQRT2);
          if (x > 0) relax(i, i + width - 1, Math.SQRT2);
        }
      }
    }
    return d;
  }

  // Signed distance in cells to the edge of the cells set in mask, positive inside. Interpolated at full resolution, its contour is a smooth outline.
  function signedDistance(mask, width, height) {
    const inside = distanceTo(mask.map(v => v ? 0 : 1), width, height), outside = distanceTo(mask, width, height), out = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? Math.min(inside[i], width + height) - 0.5 : 0.5 - Math.min(outside[i], width + height);
    return out;
  }

  // Biome map plus the climate's layer masks for Transport Fever 3's biome import.
  // waterLevel: real meters at or below which the map is water. waterFromRiver: as for render. volcanoes: OpenStreetMap volcano nodes, {lat, lon}.
  // width and height are the region's, north up. northLeft turns every image a quarter left.
  // borders: optional, state borders as [[lat, lon], ...] lines, drawn on land into the biome map. borderWidth: optional, their in-game meters across.
  async function renderBiomes(options) {
    const {bounds, width, height, climate, waterLevel, waterFromRiver, volcanoes, northLeft, borders} = options;
    const onStage = options.onStage || function () {};
    const region = boundsToRegion(bounds);
    const {width: gw, height: gh} = rasterSize(width, height);

    onStage('Fetching elevation tiles...', 0);
    const heights = await sampleRegion(region, gw, gh, pickZoom(region.x1 - region.x0, gw, 1), f => onStage('Fetching elevation tiles...', f));
    onStage('Fetching land cover...');
    const cover = await fetchImageServer(LANDCOVER_URL, region, gw, gh, 'U8', 'RSP_NearestNeighbor', f => onStage('Fetching land cover...', f));

    const spacing = GAME_METERS_PER_PIXEL * (width - 1) / (gw - 1);
    const realSpacing = groundWidth(region) / (gw - 1);
    const biome = new Uint8Array(gw * gh), mountains = new Uint8Array(gw * gh), water = new Uint8Array(gw * gh);
    const slope = new Float32Array(gw * gh);
    // The heightmap raises polder land. It stays land here too.
    const dryness = polderEdge(cover.map(lc => dryLand(lc) ? 1 : 0), gw, gh);
    const polders = polderLand(heights, gw, gh, waterLevel, i => dryness[i], POLDER_MIN_KM2 * 1e6 / realSpacing ** 2, waterFromRiver ? 0 : Math.max(1, POLDER_INLAND / realSpacing));
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const dx = (heights[y * gw + Math.min(x + 1, gw - 1)] - heights[y * gw + Math.max(x - 1, 0)]) / 2;
        const dy = (heights[Math.min(y + 1, gh - 1) * gw + x] - heights[Math.max(y - 1, 0) * gw + x]) / 2;
        slope[i] = Math.atan(Math.hypot(dx, dy) / realSpacing) * 180 / Math.PI;
        const lc = cover[i];
        // Dry land at the water level is raised in the heightmap, as polder land is.
        water[i] = lc === LC_WATER || (heights[i] <= waterLevel && !polders[i] && !(dryLand(lc) && heights[i] >= waterLevel - LOW_LAND_DEPTH)) ? 1 : 0;
        mountains[i] = slope[i] > MOUNTAIN_MASK_SLOPE ? 1 : 0;
        if (water[i]) biome[i] = 0;
        else if (lc === LC_SNOW || slope[i] > MOUNTAIN_BIOME_SLOPE) biome[i] = 4;
        else if (lc === LC_BARE || slope[i] > HILL_SLOPE) biome[i] = 3;
        else if (lc === LC_TREES || (climate === 'Subarctic' && lc === LC_FLOODED)) biome[i] = 2;
        else biome[i] = 1;
      }
    }

    const masks = {
      mountains: () => mountains,
      // The water a morphological opening removes: anything narrower than RIVER_MAX_WIDTH.
      rivers: () => {
        const radius = RIVER_MAX_WIDTH / 2 / spacing;
        const toLand = distanceTo(water.map(w => 1 - w), gw, gh);
        const toCore = distanceTo(toLand.map(d => d > radius ? 1 : 0), gw, gh);
        return water.map((w, i) => w && toCore[i] > radius ? 1 : 0);
      },
      lakes: () => water.map((w, i) => w && heights[i] > 1 ? 1 : 0),
      swamps: () => cover.map(c => c === LC_FLOODED ? 1 : 0),
      islands: () => landNotTouchingEdge(water, gw, gh),
      coast_hills: () => {
        const land = water.map(w => 1 - w);
        const r = Math.max(1, Math.round(HILL_AREA_RADIUS / realSpacing));
        const steep = boxMean(slope.map((s, i) => land[i] && s > HILL_SLOPE ? 1 : 0), gw, gh, r);
        const landShare = boxMean(land, gw, gh, r);
        const toSea = distanceTo(water.map((w, i) => w && heights[i] <= 1 ? 1 : 0), gw, gh);
        return land.map((l, i) => l && toSea[i] * realSpacing <= COAST_HILLS_DISTANCE && steep[i] >= HILL_AREA_SHARE * landShare[i] ? 1 : 0);
      },
      volcano: () => growVolcanoes(volcanoes || [], region, heights, slope, water, gw, gh, realSpacing),
      mesas: () => tablelands().mesas,
      monument_valley: () => tablelands().monumentValley
    };
    let found = null;
    function tablelands() {
      return found || (found = findTablelands(heights, slope, water, gw, gh, realSpacing));
    }

    const columns = new Int32Array(width), rows = new Int32Array(height);
    for (let i = 0; i < width; i++) columns[i] = Math.round(i * (gw - 1) / (width - 1));
    for (let j = 0; j < height; j++) rows[j] = Math.round(j * (gh - 1) / (height - 1));
    // draw(samples): optional, adds to the image at the output's own resolution.
    async function encode(grid, gray, onProgress, draw) {
      const samples = new Uint8Array(width * height);
      for (let j = 0; j < height; j++) {
        const row = rows[j] * gw;
        for (let i = 0; i < width; i++) samples[j * width + i] = gray[grid[row + columns[i]]];
      }
      if (draw) draw(samples);
      return encodeTurned(samples, width, height, 8, {}, northLeft, onProgress);
    }
    // The borders' land, at the output's resolution so the strip's edges stay smooth. Water keeps its biome. A river narrower than the grid's cells
    // counts as land, so along a river the strip mostly lies on its bed.
    let bordersKm = 0;
    const drawBorders = samples => {
      const half = (options.borderWidth || BORDER_WIDTH) / GAME_METERS_PER_PIXEL / 2, pixelKm = groundWidth(region) / (width - 1) / 1000;
      const land = (i, j) => !water[rows[j] * gw + columns[i]];
      for (const line of riverPixels(borders, region, width, height)) {
        for (let p = 2; p < line.length; p += 2) {
          const ax = line[p - 2], ay = line[p - 1], dx = line[p] - ax, dy = line[p + 1] - ay, length2 = dx * dx + dy * dy || 1;
          const mx = Math.round(ax + dx / 2), my = Math.round(ay + dy / 2);
          if (mx >= 0 && my >= 0 && mx < width && my < height && land(mx, my)) bordersKm += Math.sqrt(length2) * pixelKm;
          const i0 = Math.max(0, Math.floor(Math.min(ax, ax + dx) - half)), i1 = Math.min(width - 1, Math.ceil(Math.max(ax, ax + dx) + half));
          const j0 = Math.max(0, Math.floor(Math.min(ay, ay + dy) - half)), j1 = Math.min(height - 1, Math.ceil(Math.max(ay, ay + dy) + half));
          for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
              const s = Math.max(0, Math.min(1, ((i - ax) * dx + (j - ay) * dy) / length2));
              if (Math.hypot(i - ax - dx * s, j - ay - dy * s) <= half && land(i, j)) samples[j * width + i] = BIOME_GRAY[BORDER_BIOME];
            }
          }
        }
      }
    };
    const share = (grid, value) => grid.reduce((n, v) => n + (v === value ? 1 : 0), 0) / grid.length;
    const keys = CLIMATE_LAYERS[climate] || CLIMATE_LAYERS.Temperate;
    const writing = k => f => onStage('Writing biome maps...', (k + f) / (keys.length + 1));
    const layers = [];
    for (const [k, key] of keys.entries()) {
      writing(k)(0);
      await yieldToPage();
      const grid = masks[key]();
      layers.push({key: key, blob: await encode(grid, [0, 255], writing(k)), share: share(grid, 1)});
    }
    const drawn = await encode(biome, BIOME_GRAY, writing(keys.length), borders && borders.length ? drawBorders : null);
    return {
      // Real kilometers of border drawn, counted where the middle of each piece is land.
      bordersKm: borders ? bordersKm : null,
      biomes: drawn,
      biomeShares: [0, 1, 2, 3, 4].map(b => share(biome, b)),
      layers: layers
    };
  }

  // Mean over the square of half-width r cells around each cell.
  function boxMean(grid, width, height, r) {
    const w1 = width + 1, table = new Float64Array(w1 * (height + 1));
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) {
        row += grid[y * width + x];
        table[(y + 1) * w1 + x + 1] = table[y * w1 + x + 1] + row;
      }
    }
    const mean = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1);
        const sum = table[y1 * w1 + x1] - table[y0 * w1 + x1] - table[y1 * w1 + x0] + table[y0 * w1 + x0];
        mean[y * width + x] = sum / ((x1 - x0) * (y1 - y0));
      }
    }
    return mean;
  }

  // Growth only goes downhill so that the cone doesn't spread onto neighboring mountains.
  function growVolcanoes(volcanoes, region, heights, slope, water, width, height, spacing) {
    const mask = new Uint8Array(width * height);
    const owner = new Int32Array(width * height);
    const queue = new Int32Array(width * height);
    const maxRadius = VOLCANO_RADIUS / spacing;
    function within(cx, cy, radius, visit) {
      for (let y = Math.max(0, Math.ceil(cy - radius)); y <= Math.min(height - 1, Math.floor(cy + radius)); y++) {
        for (let x = Math.max(0, Math.ceil(cx - radius)); x <= Math.min(width - 1, Math.floor(cx + radius)); x++) {
          if (!water[y * width + x] && Math.hypot(x - cx, y - cy) <= radius) visit(y * width + x);
        }
      }
    }
    const centerLng = xToLng((region.x0 + region.x1) / 2);
    volcanoes.forEach((v, n) => {
      const id = n + 1;
      // OpenStreetMap longitudes stay within -180 to 180. They move to the copy of the world the box is in.
      const lon = v.lon + 360 * Math.round((centerLng - v.lon) / 360);
      // Growth starts at the highest land near the point, since OpenStreetMap points often sit on a flank or the crater floor.
      let top = -1;
      within((lngToX(lon) - region.x0) / (region.x1 - region.x0) * (width - 1),
        (latToY(v.lat) - region.y0) / (region.y1 - region.y0) * (height - 1),
        SUMMIT_SEARCH_RADIUS / spacing, i => { if (top < 0 || heights[i] > heights[top]) top = i; });
      if (top < 0) return;
      const cx = top % width, cy = (top - cx) / width;
      let head = 0, tail = 0;
      // Seeding the whole steep summit lets growth reach every flank past an uneven crater rim.
      within(cx, cy, VOLCANO_SEED_RADIUS / spacing, i => {
        if (i !== top && slope[i] <= HILL_SLOPE) return;
        owner[i] = id;
        queue[tail++] = i;
      });
      while (head < tail) {
        const i = queue[head++];
        mask[i] = 1;
        const x = i % width, y = (i - x) / width;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const jx = x + dx, jy = y + dy, j = jy * width + jx;
            if (jx < 0 || jy < 0 || jx >= width || jy >= height || owner[j] === id) continue;
            if (water[j] || slope[j] <= HILL_SLOPE || heights[j] > heights[i] || Math.hypot(jx - cx, jy - cy) > maxRadius) continue;
            owner[j] = id;
            queue[tail++] = j;
          }
        }
      }
    });
    return mask;
  }

  function findTablelands(heights, slope, water, width, height, spacing) {
    const n = heights.length;
    const gap = Math.round(CLIFF_GAP / spacing);
    const cliff = slope.map((s, i) => s >= CLIFF_SLOPE && !water[i] ? 1 : 0);
    const toCliff = distanceTo(cliff, width, height);
    const toOpen = distanceTo(toCliff.map(d => d > gap ? 1 : 0), width, height);
    const closed = cliff.map((c, i) => c || toOpen[i] > gap ? 1 : 0);

    // Land that reaches the map edge or water without crossing a cliff is outside every formation.
    const open = label(closed.map(c => 1 - c), width, height);
    const reachesOut = new Uint8Array(open.count + 1);
    for (let i = 0; i < n; i++) {
      const x = i % width, y = (i - x) / width;
      if (water[i] || x === 0 || y === 0 || x === width - 1 || y === height - 1) reachesOut[open.labels[i]] = 1;
    }
    const outside = open.labels.map((l, i) => water[i] || (l && reachesOut[l]) ? 1 : 0);

    // The highest foot cell rules out a loose stretch of canyon wall, whose foot runs along the plateau rim as high as its top.
    const formations = label(outside.map(o => 1 - o), width, height);
    const count = formations.count, labels = formations.labels;
    const cells = new Int32Array(count + 1), first = new Int32Array(count + 1).fill(-1);
    const summit = new Float32Array(count + 1).fill(-Infinity), foot = new Float32Array(count + 1).fill(-Infinity);
    const edge = new Uint8Array(count + 1);
    for (let i = 0; i < n; i++) {
      const l = labels[i];
      if (!l) continue;
      if (first[l] < 0) first[l] = i;
      cells[l]++;
      summit[l] = Math.max(summit[l], heights[i]);
      const x = i % width, y = (i - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge[l] = 1;
      else if (outside[i - 1] || outside[i + 1] || outside[i - width] || outside[i + width]) foot[l] = Math.max(foot[l], heights[i]);
    }
    const MESA = 1, BUTTE = 2;
    const kind = new Uint8Array(count + 1);
    for (let l = 1; l <= count; l++) {
      const km2 = cells[l] * spacing * spacing / 1e6;
      if (edge[l] || km2 < TABLELAND_MIN_KM2 || km2 > TABLELAND_MAX_KM2 || summit[l] - foot[l] < TABLELAND_MIN_RELIEF) continue;
      kind[l] = km2 >= MESA_MIN_KM2 ? MESA : BUTTE;
    }
    function footprint(k) {
      const core = labels.map(l => kind[l] === k ? 1 : 0);
      const toCore = distanceTo(core, width, height);
      return core.map((c, i) => !water[i] && (c || (toCore[i] * spacing <= TABLELAND_APRON && slope[i] > HILL_SLOPE)) ? 1 : 0);
    }
    const buttes = footprint(BUTTE);
    const groups = label(distanceTo(buttes, width, height).map(d => d * spacing <= MONUMENT_RADIUS / 2 ? 1 : 0), width, height);
    const groupSize = new Int32Array(groups.count + 1);
    for (let l = 1; l <= count; l++) if (kind[l] === BUTTE) groupSize[groups.labels[first[l]]]++;
    return {
      mesas: footprint(MESA),
      monumentValley: buttes.map((b, i) => b && groupSize[groups.labels[i]] >= MONUMENT_MIN_BUTTES ? 1 : 0)
    };
  }

  // Connected regions of nonzero cells, numbered from 1.
  function label(mask, width, height) {
    const labels = new Int32Array(mask.length), queue = new Int32Array(mask.length);
    let count = 0;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || labels[start]) continue;
      labels[start] = ++count;
      let head = 0, tail = 0;
      queue[tail++] = start;
      while (head < tail) {
        const i = queue[head++];
        const x = i % width, y = (i - x) / width;
        for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
          if (j >= 0 && mask[j] && !labels[j]) {
            labels[j] = count;
            queue[tail++] = j;
          }
        }
      }
    }
    return {labels: labels, count: count};
  }

  function rotateLeft(samples, width, height) {
    const out = new samples.constructor(samples.length);
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) out[(width - 1 - c) * height + r] = samples[r * width + c];
    }
    return out;
  }

  function encodeTurned(samples, width, height, bitDepth, text, northLeft, onProgress) {
    return northLeft ? encodeGrayPng(rotateLeft(samples, width, height), height, width, bitDepth, text, onProgress) : encodeGrayPng(samples, width, height, bitDepth, text, onProgress);
  }

  function landNotTouchingEdge(water, width, height) {
    const {labels, count} = label(water.map(w => 1 - w), width, height);
    const edge = new Uint8Array(count + 1);
    for (let x = 0; x < width; x++) edge[labels[x]] = edge[labels[(height - 1) * width + x]] = 1;
    for (let y = 0; y < height; y++) edge[labels[y * width]] = edge[labels[y * width + width - 1]] = 1;
    return labels.map(l => l && !edge[l] ? 1 : 0);
  }

  // Heights in meters for the output pixels within radius of (px, py), north up, a square 2 radius + 1 wide.
  // terrain: the heights render returned for this output, read instead of fetching. smoothing: as for render. level: as render's waterLevel.
  // plan: a water normalization plan for fetched patches, which render has already applied to terrain.
  async function terrainPatch(bounds, width, height, px, py, radius, options) {
    const {terrain, smoothing, level, plan, polders, canopy, relief, scale, lowLand} = options;
    const size = 2 * radius + 1;
    if (terrain) {
      const heights = new Float32Array(size * size);
      for (let j = 0; j < size; j++) {
        const y = Math.min(height - 1, Math.max(0, py - radius + j));
        for (let i = 0; i < size; i++) heights[j * size + i] = terrain[y * width + Math.min(width - 1, Math.max(0, px - radius + i))];
      }
      return heights;
    }
    // The blurs reach this far. A margin this wide makes the shaped and smoothed patch match the map.
    const pad = (smoothing > 0 ? 3 * (boxKernel(smoothing).r + 1) : 0) + (canopy ? canopy.reach : 0) + (relief ? reliefPad(reliefOptions(relief, 1).sigma) : 0);
    const full = size + 2 * pad, reach = radius + pad;
    const region = boundsToRegion(bounds);
    const dx = (region.x1 - region.x0) / (width - 1), dy = (region.y1 - region.y0) / (height - 1);
    const patch = {x0: region.x0 + (px - reach) * dx, x1: region.x0 + (px + reach) * dx, y0: region.y0 + (py - reach) * dy, y1: region.y0 + (py + reach) * dy};
    // Sampled exactly as render samples the map so that the patch matches the heightmap.
    const heights = await sampleRegion(patch, full, full, pickZoom(region.x1 - region.x0, width, 2), function () {});
    if (canopy) {
      await applyCanopy(canopy, heights, full, full, px - reach, py - reach, width, height);
      await softenEdges(canopy, heights, full, full, px - reach, py - reach, width, height);
    }
    if (polders) raisePolders(polders, heights, full, full, px - reach, py - reach, width, height);
    const lifted = plan ? await applyWaterPlan(plan, heights, full, full, px - reach, py - reach, width, height) : null;
    if (lowLand) await raiseLowLand(heights, full, full, patch, level, level + 1 / scale, function () {}, k => lifted !== null && lifted[k] === 1);
    if (relief) await shapeRelief(heights, full, full, level, scale, reliefOptions(relief, 1), px - reach, py - reach);
    if (!pad) return heights;
    await smoothLand(heights, full, full, smoothing, level);
    const out = new Float32Array(size * size);
    for (let j = 0; j < size; j++) out.set(heights.subarray((j + pad) * full + pad, (j + pad) * full + pad + size), j * size);
    return out;
  }

  // Replaces each cell with the least value in the square of half-width r around it, a row pass and then a column pass.
  // Van Herk and Gil-Werman's running minima from either end of blocks 2r + 1 long cost the same whatever r.
  function minFilter(grid, width, height, r) {
    const k = 2 * r + 1, ahead = new Float32Array(Math.max(width, height) + 2 * r), behind = new Float32Array(ahead.length);
    const pass = (start, step, count) => {
      const m = count + 2 * r, at = j => j < r || j >= count + r ? Infinity : grid[start + (j - r) * step];
      for (let j = 0; j < m; j++) ahead[j] = j % k ? Math.min(ahead[j - 1], at(j)) : at(j);
      for (let j = m - 1; j >= 0; j--) behind[j] = j % k === k - 1 || j === m - 1 ? at(j) : Math.min(behind[j + 1], at(j));
      for (let x = 0; x < count; x++) grid[start + x * step] = Math.min(behind[x], ahead[x + k - 1]);
    };
    for (let y = 0; y < height; y++) pass(y * width, 1, width);
    for (let x = 0; x < width; x++) pass(x, width, height);
  }

  // How far water normalization lowers each cell of a gw x gh grid, in real meters.
  // lift: real meters, the lift of the kept water nearest each cell, as distanceTo propagates it. distance: cells to that water. kept, heights, level: as in planWater.
  // A fade from each water down to land left where it is turns the land around it into a funnel. Land instead takes a regional base, the least lift
  // of the water around it, blurred, so a basin whose rivers and lakes all sit high goes down whole and keeps its slopes. Only the rest fades.
  async function normalizeOffset(lift, kept, distance, gw, gh, gameCell, scale, heights, level) {
    const sigma = NORMALIZE_BASE_BLUR / gameCell, reach = 3 * (boxKernel(sigma).r + 1), base = lift.slice(), offset = new Float32Array(gw * gh);
    // The blur reaches 3 (r + 1) cells. The least lift that near keeps the blurred base under the lift of every water it reaches, so no fade runs uphill.
    minFilter(base, gw, gh, reach);
    // Dry land past the banks caps it the same way, so the base never puts it under the guard. A valley whose stream land cover misses sits below the rivers around it.
    for (let i = 0; i < offset.length; i++) offset[i] = kept[i] || distance[i] * gameCell < NORMALIZE_BANK ? Infinity : Math.max(0, heights[i] - level - 1 / scale);
    minFilter(offset, gw, gh, reach);
    for (let i = 0; i < offset.length; i++) base[i] = Math.min(base[i], offset[i]);
    await smoothLand(base, gw, gh, sigma, -Infinity);
    // What the nearest water needs past the base fades out from it. The fade lengthens with that, so the slope it adds stays under NORMALIZE_GRADE in game.
    const fade = i => {
      const rest = lift[i] - base[i], t = rest > 0 ? Math.max(0, 1 - distance[i] * gameCell * NORMALIZE_GRADE / (rest * scale)) : 0;
      return rest * t * t * (3 - 2 * t);
    };
    for (let i = 0; i < offset.length; i++) offset[i] = fade(i);
    // Seams sit away from the water. The blur fades out toward the water, which keeps its full lowering.
    await smoothLand(offset, gw, gh, NORMALIZE_SEAM / gameCell, -Infinity);
    for (let i = 0; i < offset.length; i++) {
      const w = Math.max(0, 1 - distance[i] * gameCell / (2 * NORMALIZE_SEAM));
      offset[i] = base[i] + fade(i) * w + offset[i] * (1 - w);
    }
    return offset;
  }

  // Plans water normalization on a gw x gh grid: how far to lower each cell so rivers and lakes above the water level reach it.
  // heights and cover: real meters and land cover classes on the grid. areas: as rowAreas gives. gameCell: in-game meters per cell.
  // level: real meters the water should end at. Returns null when there is no water to work from.
  // rivers: optional, river courses on the grid as riverGrid gives them. Land cover misses rivers narrower than its 10 m cells can see.
  // Water belonging to a river left out stays where it is.
  // maxLift: in-game meters. Higher water would need a crater around it. It stays dry.
  async function planWater(heights, cover, gw, gh, areas, gameCell, scale, level, rivers, maxLift) {
    const n = gw * gh;
    const cells = rivers ? rivers.cells : null, info = rivers ? rivers.info : null;
    const course = i => cells !== null && cells[i] > 0 && info[cells[i] - 1].selected;
    const removed = rivers ? removedWater(cover, rivers, gw, gh) : null;
    // Bodies are found before any water is left out, so leaving out a river can't make the ones kept too small to normalize.
    const water = new Uint8Array(n), joined = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      joined[i] = cover[i] === LC_WATER || (rivers && rivers.owners[i] > 0) ? 1 : 0;
      water[i] = (cover[i] === LC_WATER && !(removed && removed[i])) || course(i) ? 1 : 0;
    }
    // Trees and bridges break rivers into pieces. Pieces two cells apart count as one water body.
    const {labels, count} = label(distanceTo(joined, gw, gh).map(d => d <= 2 ? 1 : 0), gw, gh);
    const bodyArea = new Float64Array(count + 1);
    for (let i = 0; i < n; i++) if (joined[i]) bodyArea[labels[i]] += areas[(i / gw) | 0];
    // The lowest water neighbor keeps bank cells out of the surface. A blur along the water evens out survey steps.
    // Water more than DAM_STEP lower is past a dam, whose tailwater isn't this water's surface.
    // A river course only marks where the river runs. Its surface is the lowest ground right around it, but not a pit beside it, like a mine: the third lowest.
    const sum = new Float32Array(n), weight = new Float32Array(n), near = [], dam = new Uint8Array(n);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (!water[i] || bodyArea[labels[i]] < NORMALIZE_MIN_KM2 * 1e6) continue;
        let low = heights[i], level = heights[i], upper = false;
        near.length = 0;
        for (let v = Math.max(0, y - 1); v <= Math.min(gh - 1, y + 1); v++) {
          for (let u = Math.max(0, x - 1); u <= Math.min(gw - 1, x + 1); u++) {
            const j = v * gw + u, h = heights[j];
            if (course(i)) near.push(h);
            else if (water[j]) {
              low = Math.min(low, h);
              if (h >= heights[i] - DAM_STEP) level = Math.min(level, h);
              upper = upper || (j !== i && Math.abs(h - heights[i]) <= DAM_STEP);
            }
          }
        }
        // Water lying level with water beside it, above a drop, is a reach above a dam. A lone high cell on a bank still takes the lowest water.
        if (upper && low < heights[i] - DAM_STEP) {
          low = level;
          dam[i] = 1;
        }
        if (near.length) {
          low = Math.min(heights[i], near.sort((a, b) => a - b)[Math.min(2, near.length - 1)]);
          dam[i] = 1;
        }
        sum[i] = low;
        weight[i] = 1;
      }
    }
    const kept = weight.slice(), own = sum.slice();
    const {r, share} = boxKernel(3);
    for (let pass = 0; pass < 3; pass++) {
      boxSum(sum, gw, gh, r, share);
      boxSum(weight, gw, gh, r, share);
    }
    // The blur smears the step at a dam, which would leave the reach above it too low to reach. Such water, and a course, is never put below its own low.
    const surface = new Float32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (!kept[i]) continue;
      surface[i] = dam[i] ? Math.max(sum[i] / weight[i], own[i]) : sum[i] / weight[i];
      any = true;
    }
    if (!any) return null;

    const guard = 1 / scale;
    maxLift /= scale;
    const lift = new Float32Array(n), lowered = new Uint8Array(n), atLevel = new Uint8Array(n);
    // The limit goes cell by cell. A river climbing into hills still fills its lower reaches. A lake, being flat, fills or stays dry whole.
    const bodies = new Uint8Array(count + 1);
    let deepest = 0, dryArea = 0;
    for (let i = 0; i < n; i++) {
      if (!kept[i]) continue;
      if (surface[i] - level > maxLift) {
        kept[i] = 0;
        dryArea += areas[(i / gw) | 0];
        continue;
      }
      lift[i] = Math.max(0, surface[i] - level);
      if (lift[i] > guard) lowered[i] = 1;
      else atLevel[i] = 1;
      bodies[labels[i]] |= lowered[i] ? 2 : 1;
      deepest = Math.max(deepest, lift[i] * scale);
    }
    // River lines are drawn at full resolution with their own width. Over land they stay out of the coarse shoreline rules below: 1 at the level, 2 lowered.
    // Over mapped water they keep those rules and widen and deepen it: 3 at the level, 4 lowered. Over a lake or the sea they leave it alone.
    // A tributary's course in a bigger selected river's water is judged by that river, so it goes on to meet that river's bed instead of stopping at its bank.
    const lineClass = new Uint8Array(n), widest = rivers ? selectedRadius(cover, rivers, gw, gh, course) : null;
    if (rivers) {
      for (let i = 0; i < n; i++) {
        if (!course(i)) continue;
        const r = cells[i] - 1;
        if (cover[i] !== LC_WATER) {
          lineClass[i] = lowered[i] ? 2 : atLevel[i] ? 1 : 0;
          lowered[i] = atLevel[i] = 0;
        } else if (!rivers.wideAt(i, Math.max(info[r].radius, widest[i],
          // A navigable river's channel runs on through water narrower than itself, like a reservoir on its course.
          info[r].navigable * GAME_METERS_PER_PIXEL / gameCell * Math.max(0, Math.min(1, (NAVIGABLE_ELEVATION + NAVIGABLE_FADE - lift[i]) / NAVIGABLE_FADE))))) {
          lineClass[i] = lowered[i] ? 4 : atLevel[i] ? 3 : 0;
        }
        if (lineClass[i]) info[r].carved = true;
      }
    }
    const outline = signedDistance(lowered, gw, gh), wet = signedDistance(kept, gw, gh);
    const stats = {lowered: bodies.filter(b => b & 2).length, dryKm2: dryArea / 1e6, deepest: deepest,
      rivers: rivers ? {selected: info.filter(r => r.selected).length, carved: info.filter(r => r.carved).length, removed: info.filter(r => r.removed).length} : null};
    // Water at the level that surveys a little above it, like a tidal channel, has its own flat surface, which draws its shoreline.
    // The median of its neighbors skips bank samples.
    const channelSum = new Float32Array(n), channelWeight = new Float32Array(n);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (!atLevel[i] || !(heights[i] > level)) continue;
        near.length = 0;
        for (let v = Math.max(0, y - 1); v <= Math.min(gh - 1, y + 1); v++) {
          for (let u = Math.max(0, x - 1); u <= Math.min(gw - 1, x + 1); u++) {
            const j = v * gw + u;
            if (atLevel[j] && heights[j] > level && heights[j] <= level + LEVEL_WATER_TOLERANCE) near.push(heights[j]);
          }
        }
        if (!near.length) continue;
        near.sort((p, q) => p - q);
        channelSum[i] = near[near.length >> 1];
        channelWeight[i] = 1;
      }
    }
    const channel = new Float32Array(n).fill(NaN), hasChannel = channelWeight.slice();
    const k2 = boxKernel(2);
    for (let pass = 0; pass < 3; pass++) {
      boxSum(channelSum, gw, gh, k2.r, k2.share);
      boxSum(channelWeight, gw, gh, k2.r, k2.share);
    }
    for (let i = 0; i < n; i++) if (hasChannel[i]) channel[i] = channelSum[i] / channelWeight[i];

    // Water that needs no lowering, like the sea, also holds the land beside it where it is.
    const distance = distanceTo(kept, gw, gh, lift);
    const offset = await normalizeOffset(lift, kept, distance, gw, gh, gameCell, scale, heights, level);
    return {offset: offset, lift: lift, outline: outline, wet: wet, channel: channel, lineClass: lineClass, kept: kept, level: level, guard: guard, scale: scale, gw: gw, gh: gh, stats: stats};
  }

  // The radius riverGrid's wide test takes for the widest selected river whose water reaches each land cover water cell from its course, or 0.
  // rivers: as riverGrid gives them. course(i): whether cell i is on a selected river's course.
  function selectedRadius(cover, rivers, gw, gh, course) {
    const {cells, info} = rivers, n = gw * gh, radius = new Float32Array(n), visit = new Int32Array(n), queue = new Int32Array(n), steps = new Uint16Array(n);
    const order = info.map((r, i) => i).filter(i => info[i].selected).sort((a, b) => info[b].radius - info[a].radius), seeds = info.map(() => []);
    for (let i = 0; i < n; i++) if (course(i)) seeds[cells[i] - 1].push(i);
    order.forEach((r, round) => {
      let tail = 0;
      for (const i of seeds[r]) {
        visit[i] = round + 1;
        steps[i] = 0;
        queue[tail++] = i;
      }
      for (let head = 0; head < tail; head++) {
        const i = queue[head], x = i % gw;
        radius[i] = Math.max(radius[i], info[r].radius);
        if (steps[i] >= info[r].reach) continue;
        for (let v = -1; v <= 1; v++) {
          for (let u = -1; u <= 1; u++) {
            const j = i + v * gw + u;
            if ((!u && !v) || x + u < 0 || x + u >= gw || j < 0 || j >= n || visit[j] === round + 1 || cover[j] !== LC_WATER) continue;
            visit[j] = round + 1;
            steps[j] = steps[i] + 1;
            queue[tail++] = j;
          }
        }
      }
    });
    return radius;
  }

  // River courses on a gw x gh grid for planWater, from rivers as [{lines, width, typical, selected, navigable}]:
  // lines as [[lat, lon], ...], width the selected channel's in-game meters, typical the river's real meters across,
  // navigable optional, in-game meters the channel widens to in the lowlands, or 0.
  // reach: grid cells Natural Earth's courses may stray from their rivers, or 0.
  // Returns {cells, owners, info, lines, measured, wide(i, r)}. cells holds 1 + the index of the river whose course runs through a cell, selected and then wider rivers first.
  // owners also marks where Natural Earth's courses run before they're moved onto water, which only finds the water a river owns.
  // lines are the selected courses in output pixels, as {points, river}. measured is each cell's distance in cells to land cover that isn't water.
  // wide(i, r) tells water at cell i too wide for river r, a lake or the sea it runs through.
  function riverGrid(rivers, region, width, height, cover, gw, gh, areas, reach) {
    const n = gw * gh, sx = (gw - 1) / (width - 1), sy = (gh - 1) / (height - 1), cellMeters = Math.sqrt(areas[gh >> 1]);
    const info = rivers.map(r => ({
      selected: r.selected, halfWidth: r.width / GAME_METERS_PER_PIXEL / 2, navigable: (r.navigable || 0) / GAME_METERS_PER_PIXEL / 2, carved: false, removed: false,
      reach: Math.ceil(RIVER_REACH_FACTOR * r.typical / cellMeters) + RIVER_LAND_STEPS,
      radius: Math.max(RIVER_WIDE_MIN_RADIUS, RIVER_WIDE_FACTOR / 2 * r.typical / cellMeters)
    }));
    const cells = new Uint16Array(n), owners = new Uint16Array(n), lines = [];
    const order = rivers.map((r, i) => i).sort((a, b) => (rivers[b].selected - rivers[a].selected) || (rivers[b].typical - rivers[a].typical));
    // Natural Earth's courses stray from their rivers. They run where they meet land cover water nearby. Where they were drawn still marks water the river owns.
    const snap = reach >= 1 ? lineSnapper(cover, gw, gh, sx, sy, reach) : null;
    const mark = (i, r) => {
      if (!cells[i]) cells[i] = r + 1;
      if (!owners[i]) owners[i] = r + 1;
    };
    for (const r of order) {
      const pixels = riverPixels(rivers[r].lines, region, width, height), courses = snap ? pixels.map(snap) : pixels;
      if (rivers[r].selected) {
        // A channel copying every bend narrower than itself, and every long straight piece, gets ragged banks. It follows the course smoothed over about its width.
        // Its points, a pixel apart, and the middles between them mark its cells by courseCell, so every lookup along the channel finds its own course.
        const sigma = Math.max(1, RIVER_COURSE_SMOOTHING * 2 * info[r].halfWidth);
        for (const line of courses.map(c => smoothCourse(c, sigma))) {
          for (let q = 0; q < line.length; q += 2) {
            mark(courseCell(line[q], line[q + 1], sx, sy, gw, gh), r);
            if (q) mark(courseCell((line[q - 2] + line[q]) / 2, (line[q - 1] + line[q + 1]) / 2, sx, sy, gw, gh), r);
          }
          lines.push({points: line, river: r});
        }
      } else {
        for (const line of courses) walkLine(line, sx, sy, 0, 0, gw, gh, 0, i => mark(i, r));
      }
      if (snap) {
        for (const line of pixels) {
          walkLine(line, sx, sy, 0, 0, gw, gh, 0, i => {
            if (!owners[i]) owners[i] = r + 1;
          });
        }
      }
    }
    const measured = distanceTo(cover.map(c => c === LC_WATER ? 0 : 1), gw, gh);
    // Water inside a circle of water wider than the river is wide for it. The open sea has no land cover data, which counts as water here.
    // Each river's radius is rounded to one of a few, each needing its own pass over the grid.
    const open = distanceTo(cover.map(c => c === LC_WATER || c === LC_NO_DATA ? 0 : 1), gw, gh), masks = new Map();
    const wide = (i, r) => wideAt(i, info[r].radius);
    function wideAt(i, radius) {
      const bin = Math.round(2 * Math.log2(radius));
      if (!masks.has(bin)) {
        const radius = 2 ** (bin / 2), centers = new Uint8Array(n), mask = new Uint8Array(n);
        for (let j = 0; j < n; j++) centers[j] = open[j] - 0.5 > radius ? 1 : 0;
        const d = distanceTo(centers, gw, gh);
        for (let j = 0; j < n; j++) mask[j] = d[j] <= radius ? 1 : 0;
        masks.set(bin, mask);
      }
      return masks.get(bin)[i] === 1;
    }
    return {cells: cells, owners: owners, info: info, lines: lines, measured: measured, wide: wide, wideAt: wideAt};
  }

  // Land cover water belonging to rivers left out, as riverGrid describes them: water reached through the water from such a river's course
  // before any selected river's, within its reach. A selected river's course goes first, so it wins water both reach in as many steps.
  // Water too wide for the river, like a lake or the sea it runs through, stays. Returns the cells to leave alone, or null.
  function removedWater(cover, rivers, gw, gh) {
    const {owners: cells, info} = rivers;
    if (info.every(r => r.selected)) return null;
    const n = gw * gh, owner = new Uint16Array(n), steps = new Uint16Array(n), queue = new Int32Array(n);
    let tail = 0;
    for (const selected of [true, false]) {
      for (let i = 0; i < n; i++) {
        if (cells[i] && info[cells[i] - 1].selected === selected) {
          owner[i] = cells[i];
          queue[tail++] = i;
        }
      }
    }
    for (let head = 0; head < tail; head++) {
      const i = queue[head], s = steps[i] + 1, x = i % gw, onLand = cover[i] !== LC_WATER;
      if (s > info[owner[i] - 1].reach) continue;
      for (let v = -1; v <= 1; v++) {
        for (let u = -1; u <= 1; u++) {
          const j = i + v * gw + u;
          if ((!u && !v) || x + u < 0 || x + u >= gw || j < 0 || j >= n || owner[j]) continue;
          // A course drawn beside its water crosses a little land to reach it. Water never spreads over land.
          if (cover[j] !== LC_WATER && !(onLand && s <= RIVER_LAND_STEPS)) continue;
          owner[j] = owner[i];
          steps[j] = s;
          queue[tail++] = j;
        }
      }
    }
    const removed = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = owner[i] - 1;
      if (r < 0 || info[r].selected || cover[i] !== LC_WATER || rivers.wide(i, r)) continue;
      removed[i] = 1;
      info[r].removed = true;
    }
    return removed;
  }

  // Real meters across each river's water where land cover sees it, or NaN where it sees too little of it.
  // rivers: [{lines}], lines as [[lat, lon], ...]. cover: as landCoverFor gives it.
  // A river that land cover sees only here and there is too narrow for its cells. The water its course does meet is mostly the lakes along it.
  // Courses that stray from their rivers, like Natural Earth's, aren't moved onto nearby water for the same reason. Natural Earth's lake centerlines measure as lakes, and are left out.
  function measureRivers(bounds, width, height, rivers, cover) {
    const region = boundsToRegion(bounds), {width: gw, height: gh} = rasterSize(width, height);
    const sx = (gw - 1) / (width - 1), sy = (gh - 1) / (height - 1), areas = rowAreas(region, gw, gh);
    const depth = distanceTo(cover.map(c => c === LC_WATER ? 0 : 1), gw, gh);
    return rivers.map(river => {
      const lines = riverPixels(river.lines, region, width, height);
      const seen = new Set(), widths = [];
      for (const line of lines) walkLine(line, sx, sy, 0, 0, gw, gh, 0, i => seen.add(i));
      for (const i of seen) {
        if (cover[i] !== LC_WATER) continue;
        // A course off its river's middle sees the nearer bank. The deepest water beside it lies closer to the middle.
        const x = i % gw, y = (i - x) / gw;
        let d = 0;
        for (let v = Math.max(0, y - 1); v <= Math.min(gh - 1, y + 1); v++) {
          for (let u = Math.max(0, x - 1); u <= Math.min(gw - 1, x + 1); u++) if (cover[v * gw + u] === LC_WATER) d = Math.max(d, depth[v * gw + u]);
        }
        widths.push((2 * d - 1) * Math.sqrt(areas[y]));
      }
      if (widths.length < 3 || widths.length < RIVER_MEASURED_SHARE * seen.size) return NaN;
      // Lakes and reservoirs along the course are far wider than the river's own reaches, the narrower ones. They're left out like wide water.
      widths.sort((a, b) => a - b);
      const low = widths[widths.length >> 2], narrow = widths.filter(w => w <= RIVER_WIDE_FACTOR * low);
      const median = narrow[narrow.length >> 1], cell = Math.sqrt(areas[gh >> 1]);
      return median >= RIVER_MEASURED_MIN_CELLS * cell && narrow.length * cell >= RIVER_MEASURED_ELONGATION * median ? median : NaN;
    });
  }

  // heights: real meters for the whole output, or null to fetch coarser ones. cover: optional, land cover as landCoverFor gives it.
  // rivers: optional, as for riverGrid. riverSlack: optional, real meters Natural Earth's courses may stray from their river.
  // maxLift: as for planWater.
  async function planWaterFor(region, width, height, heights, scale, level, onStage, rivers, riverSlack, cover, maxLift, canopy) {
    const {width: gw, height: gh} = rasterSize(width, height);
    let coarse;
    if (heights) {
      coarse = new Float32Array(gw * gh);
      for (let j = 0; j < gh; j++) {
        const row = Math.round(j * (height - 1) / (gh - 1)) * width;
        for (let i = 0; i < gw; i++) coarse[j * gw + i] = heights[row + Math.round(i * (width - 1) / (gw - 1))];
      }
    } else {
      onStage('Fetching elevation tiles...', 0);
      coarse = await sampleRegion(region, gw, gh, pickZoom(region.x1 - region.x0, gw, 1), f => onStage('Fetching elevation tiles...', f));
      // Fetched heights still carry the forest render takes off first.
      if (canopy) await applyCanopy(canopy, coarse, gw, gh, 0, 0, gw, gh);
    }
    cover = cover || await landCoverFor(region, width, height, onStage);
    const areas = rowAreas(region, gw, gh), reach = (riverSlack || 0) / (groundWidth(region) / (gw - 1));
    const grid = rivers && rivers.length ? riverGrid(rivers, region, width, height, cover, gw, gh, areas, reach) : null;
    const plan = await planWater(coarse, cover, gw, gh, areas, GAME_METERS_PER_PIXEL * (width - 1) / (gw - 1), scale, level, grid, maxLift);
    if (plan) plan.cover = cover;
    if (plan && grid) {
      Object.assign(plan, {lines: grid.lines, halfWidths: grid.info.map(r => r.halfWidth), navigable: grid.info.map(r => r.navigable), measured: grid.measured});
      courseTaper(plan, width, height);
      courseNavigable(plan, width, height);
    }
    return plan;
  }

  // Moves lines, in output pixels, onto the nearest land cover water within reach grid cells. sx, sy: grid cells per output pixel.
  // A line that strays from its river then runs in the river where land cover sees it, and bridges its gaps instead of cutting a second channel beside it.
  // Returns a function moving one line at a time, so the distance transform is worked out once for all lines.
  function lineSnapper(cover, gw, gh, sx, sy, reach) {
    const water = new Uint8Array(gw * gh), nearest = new Int32Array(gw * gh);
    for (let i = 0; i < water.length; i++) {
      water[i] = cover[i] === LC_WATER ? 1 : 0;
      nearest[i] = i;
    }
    const distance = distanceTo(water, gw, gh, nearest);
    return line => {
      const out = [];
      const add = (x, y) => {
        const u = Math.round(x * sx), v = Math.round(y * sy), i = v * gw + u;
        if (u >= 0 && v >= 0 && u < gw && v < gh && distance[i] <= reach) out.push(nearest[i] % gw / sx, Math.floor(nearest[i] / gw) / sy);
        else out.push(x, y);
      };
      add(line[0], line[1]);
      for (let p = 2; p < line.length; p += 2) {
        const ax = line[p - 2], ay = line[p - 1], steps = Math.ceil(Math.hypot((line[p] - ax) * sx, (line[p + 1] - ay) * sy));
        for (let s = 1; s <= steps; s++) add(ax + (line[p] - ax) * s / steps, ay + (line[p + 1] - ay) * s / steps);
      }
      return Float64Array.from(out);
    };
  }

  // Land cover classes on the water plan's grid for an output.
  function landCoverFor(region, width, height, onStage) {
    const {width: gw, height: gh} = rasterSize(width, height);
    onStage('Fetching land cover...');
    // Each cell takes its most common class. A point sample would make a whole cell of water out of any pond it happened to land on.
    return fetchImageServer(LANDCOVER_URL, region, gw, gh, 'U8', 'RSP_Majority', f => onStage('Fetching land cover...', f));
  }

  // Marsh counts as water. Open sea has no land cover data at all.
  function dryLand(lc) {
    return lc !== LC_NO_DATA && lc !== LC_WATER && lc !== LC_FLOODED && lc !== LC_CLOUDS;
  }

  // Dry land at or below the waterline that the game's single water level would wrongly drown, marked nonzero.
  // dryness(k): signed distance in land cover cells from pixel k to water, 0 or more on dry land. inland: in the same cells.
  function polderLand(heights, width, height, waterline, dryness, minPixels, inland) {
    const DRY = 1, REACHED = 2, DEEP = 4, RAISE = 8, state = new Uint8Array(width * height);
    let low = 0, tail = 0;
    for (let k = 0; k < state.length; k++) if (heights[k] <= waterline) low++;
    const queue = new Int32Array(low);
    for (let k = 0; k < state.length; k++) {
      if (!(heights[k] <= waterline)) continue;
      const d = dryness(k);
      if (d < 0) {
        state[k] = REACHED;
        queue[tail++] = k;
      } else {
        state[k] = DRY | (d >= inland || (d >= 1 && heights[k] < waterline - POLDER_DEPTH) ? DEEP : 0);
      }
    }
    const spread = (k, from, to) => {
      const x = k % width;
      for (const n of [x > 0 ? k - 1 : -1, x < width - 1 ? k + 1 : -1, k - width, k + width]) {
        if (n >= 0 && n < state.length && (state[n] & (DRY | REACHED | to)) === from) {
          state[n] |= to;
          queue[tail++] = n;
        }
      }
    };
    for (let head = 0; head < tail; head++) spread(queue[head], DRY, REACHED);
    for (let k = 0; k < state.length; k++) {
      if ((state[k] & (DRY | REACHED | RAISE)) !== DRY) continue;
      tail = 0;
      state[k] |= RAISE;
      queue[tail++] = k;
      for (let head = 0; head < tail; head++) spread(queue[head], DRY, RAISE);
      if (tail < minPixels) for (let q = 0; q < tail; q++) state[queue[q]] |= REACHED;
    }
    for (let k = 0; k < state.length; k++) state[k] = state[k] & DEEP || (state[k] & (RAISE | REACHED)) === RAISE ? 1 : 0;
    return state;
  }

  // Land cover's cells would draw a raised shore as a staircase. A light blur straightens it, at the cost of water one cell wide.
  function polderEdge(dry, gw, gh) {
    return boxMean(signedDistance(dry, gw, gh), gw, gh, 1);
  }

  // The game has one water level, which would drown dry land enclosed below it, like polders. Such land goes one in-game meter above the water instead.
  // cover: as landCoverFor gives it. waterline: real meters at or below which the map is water.
  // pixelMeters, cellMeters: real meters per output pixel and per land cover cell.
  // everywhere: raise all dry land below the waterline, for a level taken from a river's lowest point, where any lake below it would be made up.
  function polderPlan(cover, gw, gh, waterline, scale, pixelMeters, cellMeters, everywhere) {
    const dry = new Uint8Array(gw * gh);
    for (let i = 0; i < dry.length; i++) dry[i] = dryLand(cover[i]) ? 1 : 0;
    return {edge: polderEdge(dry, gw, gh), gw: gw, gh: gh, waterline: waterline, top: waterline + 1 / scale,
      minPixels: POLDER_MIN_KM2 * 1e6 / pixelMeters ** 2, inland: everywhere ? 0 : Math.max(1, POLDER_INLAND / cellMeters)};
  }

  // Dry land left at the water level or up to LOW_LAND_DEPTH under it, like a sand spit, goes to top, as polder land does. The elevation tiles put spits
  // about at the level, and normalization fills land that low beside the sea as it fills tidal channels. Land cover's cells are far wider than a spit,
  // and land joined to the water stays water for polders, so land cover is fetched again at twice the output's resolution, only in the pieces
  // of the map that have ground that low. Land left a pixel thin gets a second pixel, the higher neighbour across it, so the game shows it as more than a sliver.
  // heights: real meters, the whole output. waterline, top: real meters. water(k): whether pixel k must stay water, like a river channel.
  // Returns how many pixels it raised in each row.
  async function raiseLowLand(heights, width, height, region, waterline, top, onStage, water) {
    const raised = new Float64Array(height), done = [];
    const low = k => heights[k] <= waterline && heights[k] >= waterline - LOW_LAND_DEPTH && !water(k);
    // Pieces about LOW_LAND_TILE wide, the last ones no thinner than the rest.
    const cuts = size => {
      const count = Math.ceil((size - 1) / LOW_LAND_TILE), out = [];
      for (let c = 0; c <= count; c++) out.push(Math.round(c * (size - 1) / count));
      return out;
    };
    const xs = cuts(width), ys = cuts(height), pieces = [];
    for (let b = 1; b < ys.length; b++) {
      for (let a = 1; a < xs.length; a++) {
        const x0 = xs[a - 1], y0 = ys[b - 1], w = xs[a] - x0 + 1, h = ys[b] - y0 + 1;
        let any = false;
        for (let j = y0; j < y0 + h && !any; j++) for (let i = x0; i < x0 + w && !any; i++) any = low(j * width + i);
        if (any) pieces.push([x0, y0, w, h]);
      }
    }
    const dx = (region.x1 - region.x0) / (width - 1), dy = (region.y1 - region.y0) / (height - 1);
    for (const [p, [x0, y0, w, h]] of pieces.entries()) {
      onStage('Fetching detailed land cover...', p / pieces.length);
      const piece = {x0: region.x0 + x0 * dx, x1: region.x0 + (x0 + w - 1) * dx, y0: region.y0 + y0 * dy, y1: region.y0 + (y0 + h - 1) * dy};
      // Points half a pixel apart, every other one a pixel's middle. A tent over the 3 x 3 points around a pixel weighs its share of dry land.
      const sw = 2 * w - 1, sh = 2 * h - 1, cover = await fetchImageServer(LANDCOVER_URL, piece, sw, sh, 'U8', 'RSP_Majority');
      const dry = (u, v) => dryLand(cover[Math.min(sh - 1, Math.max(0, v)) * sw + Math.min(sw - 1, Math.max(0, u))]) ? 1 : 0;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const k = (y0 + j) * width + x0 + i, u = 2 * i, v = 2 * j;
          // A piece's first column and row are the last of the piece before it.
          if ((i === 0 && x0 > 0) || (j === 0 && y0 > 0) || !low(k)) continue;
          const share = (4 * dry(u, v) + 2 * (dry(u - 1, v) + dry(u + 1, v) + dry(u, v - 1) + dry(u, v + 1)) +
            dry(u - 1, v - 1) + dry(u + 1, v - 1) + dry(u - 1, v + 1) + dry(u + 1, v + 1)) / 16;
          if (share >= LOW_LAND_SHARE) done.push(k);
        }
      }
    }
    // Only once every piece is in, so a failed fetch leaves the map as it was.
    for (const k of done) {
      heights[k] = top;
      raised[(k / width) | 0]++;
    }
    // Decided on the land as raised, so a spit only thickens once.
    const thick = [];
    for (const k of done) {
      const x = k % width;
      for (const [a, b] of [[x > 0 ? k - 1 : -1, x < width - 1 ? k + 1 : -1], [k - width, k + width]]) {
        if (a < 0 || b < 0 || a >= heights.length || b >= heights.length || heights[a] > waterline || heights[b] > waterline) continue;
        const c = heights[a] >= heights[b] ? a : b;
        if (low(c)) thick.push(c);
      }
    }
    for (const k of thick) {
      if (heights[k] >= top) continue;
      heights[k] = top;
      raised[(k / width) | 0]++;
    }
    return raised;
  }

  // Returns how many pixels it raised in each row.
  // The grid covers output pixels x0 to x0 + width - 1 and y0 to y0 + height - 1 of an output outputWidth x outputHeight.
  function raisePolders(polders, heights, width, height, x0, y0, outputWidth, outputHeight) {
    const {edge, gw, gh, waterline, top, minPixels, inland} = polders;
    const sx = (gw - 1) / (outputWidth - 1), sy = (gh - 1) / (outputHeight - 1), raised = new Float64Array(height);
    const land = polderLand(heights, width, height, waterline, k => {
      const i = k % width, j = (k - i) / width;
      const v = Math.min(gh - 1, Math.max(0, (y0 + j) * sy)), r = Math.min(Math.floor(v), gh - 2), fy = v - r;
      const u = Math.min(gw - 1, Math.max(0, (x0 + i) * sx)), c = Math.min(Math.floor(u), gw - 2), fx = u - c, a = r * gw + c;
      return (edge[a] * (1 - fx) + edge[a + 1] * fx) * (1 - fy) + (edge[a + gw] * (1 - fx) + edge[a + gw + 1] * fx) * fy;
    }, minPixels, inland);
    for (let k = 0; k < land.length; k++) {
      if (!land[k]) continue;
      heights[k] = top;
      raised[(k / width) | 0]++;
    }
    return raised;
  }

  // River courses, [[lat, lon], ...] lines, as [x0, y0, x1, y1, ...] in output pixels.
  function riverPixels(rivers, region, width, height) {
    const centerLng = xToLng((region.x0 + region.x1) / 2);
    return rivers.map(line => {
      const out = new Float64Array(line.length * 2);
      line.forEach(([lat, lng], p) => {
        // OpenStreetMap longitudes stay within -180 to 180. They move to the copy of the world the region is in.
        out[2 * p] = (lngToX(lng + 360 * Math.round((centerLng - lng) / 360)) - region.x0) / (region.x1 - region.x0) * (width - 1);
        out[2 * p + 1] = (latToY(lat) - region.y0) / (region.y1 - region.y0) * (height - 1);
      });
      return out;
    });
  }

  // The plan cell a point of a course in output pixels falls in. riverGrid marks courses, and channelBand and courseTaper read them, by this one rule.
  function courseCell(x, y, sx, sy, gw, gh) {
    return Math.round(Math.min(gh - 1, Math.max(0, y * sy))) * gw + Math.round(Math.min(gw - 1, Math.max(0, x * sx)));
  }

  // A course in output pixels, [x0, y0, x1, y1, ...], resampled a pixel apart and blurred along its length with a Gaussian of sigma pixels.
  // Its ends stay where they are, and the blur fades in from them, so courses joined end to end still meet.
  function smoothCourse(line, sigma) {
    const points = [line[0], line[1]];
    for (let p = 2; p < line.length; p += 2) {
      const ax = line[p - 2], ay = line[p - 1], steps = Math.ceil(Math.hypot(line[p] - ax, line[p + 1] - ay));
      for (let s = 1; s <= steps; s++) points.push(ax + (line[p] - ax) * s / steps, ay + (line[p + 1] - ay) * s / steps);
    }
    const count = points.length / 2, reach = Math.ceil(3 * sigma), out = new Float64Array(points.length);
    if (count < 3) return Float64Array.from(points);
    for (let i = 0; i < count; i++) {
      let x = 0, y = 0, w = 0;
      for (let j = Math.max(0, i - reach); j <= Math.min(count - 1, i + reach); j++) {
        const g = Math.exp(-((j - i) ** 2) / (2 * sigma * sigma));
        x += g * points[2 * j];
        y += g * points[2 * j + 1];
        w += g;
      }
      const hold = Math.min(1, i / sigma, (count - 1 - i) / sigma);
      out[2 * i] = points[2 * i] + (x / w - points[2 * i]) * hold;
      out[2 * i + 1] = points[2 * i + 1] + (y / w - points[2 * i + 1]) * hold;
    }
    return out;
  }

  // Calls visit(index) for each cell of a width x height grid within radius of a line, scaled by sx and sy, with the grid starting at output pixel (x0, y0).
  // A cell can be visited more than once.
  function walkLine(line, sx, sy, x0, y0, width, height, radius, visit) {
    const brush = [];
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) if (dx * dx + dy * dy <= radius * radius) brush.push([dx, dy]);
    }
    for (let p = 2; p < line.length; p += 2) {
      const ax = line[p - 2] * sx - x0, ay = line[p - 1] * sy - y0, bx = line[p] * sx - x0, by = line[p + 1] * sy - y0;
      if (Math.max(ax, bx) < -radius - 1 || Math.min(ax, bx) > width + radius || Math.max(ay, by) < -radius - 1 || Math.min(ay, by) > height + radius) continue;
      const steps = Math.ceil(2 * Math.max(Math.abs(bx - ax), Math.abs(by - ay))) + 1;
      for (let s = 0; s <= steps; s++) {
        const cx = Math.round(ax + (bx - ax) * s / steps), cy = Math.round(ay + (by - ay) * s / steps);
        for (const [dx, dy] of brush) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && y >= 0 && x < width && y < height) visit(y * width + x);
        }
      }
    }
  }

  // Returns which cells hold water it lowered to the plan's level.
  // The grid covers output pixels x0 to x0 + width - 1 and y0 to y0 + height - 1 of an output outputWidth x outputHeight.
  // onProgress(fraction): optional, called every ROW_BATCH rows, and awaited.
  // beds: optional, {ratio, min, max}: a river channel's depth in in-game meters is ratio times its width, kept between min and max,
  // sloping down from its banks at RIVER_EDGE_SLOPE and as shallow as its width where it tapers to its end.
  // With beds it returns {lifted, bed, band} instead: bed holds each channel pixel's depth below the level in eighths of an in-game meter, or 0,
  // and band the channels as channelBand gives them, for shapeShores.
  async function applyWaterPlan(plan, heights, width, height, x0, y0, outputWidth, outputHeight, onProgress, beds) {
    const {offset, lift, outline, wet, channel, level, guard, scale, gw, gh} = plan;
    const sx = (gw - 1) / (outputWidth - 1), sy = (gh - 1) / (outputHeight - 1);
    const lifted = new Uint8Array(width * height), bed = beds ? new Uint8Array(width * height) : null;
    // Pixels from a channel's edge where its bank stops rising.
    const bankReach = RIVER_LINE_TOLERANCE * scale / (GAME_METERS_PER_PIXEL * RIVER_BANK_GRADE);
    // Lines in this margin around the grid still cut into it. Channels over mapped water need none, since the plan's coarse water already reaches in.
    const reach = Math.max(bankReach, SHORE_BAND + 1) + 1;
    const margin = plan.lines ? Math.min(BAND_MAX_MARGIN, Math.ceil(plan.halfWidths.concat(plan.navigable || []).reduce((m, w) => Math.max(m, w), 0) + reach) + 1) : 0;
    const band = plan.lines ? channelBand(plan, x0, y0, width, height, outputWidth, outputHeight, margin, reach, beds) : null, padded = width + 2 * margin;
    // A channel's bed slopes down from its banks and is flat at its full depth across the middle.
    const depthAt = (e, deep) => Math.min(255, Math.round(Math.min(deep, 8 * RIVER_EDGE_SLOPE * -e)));
    for (let j = 0; j < height; j++) {
      const v = Math.min(gh - 1, Math.max(0, (y0 + j) * sy)), r = Math.min(Math.floor(v), gh - 2), fy = v - r;
      for (let i = 0; i < width; i++) {
        const u = Math.min(gw - 1, Math.max(0, (x0 + i) * sx)), c = Math.min(Math.floor(u), gw - 2), fx = u - c, a = r * gw + c;
        const k = j * width + i, before = heights[k];
        heights[k] -= (offset[a] * (1 - fx) + offset[a + 1] * fx) * (1 - fy) + (offset[a + gw] * (1 - fx) + offset[a + gw + 1] * fx) * fy;
        // Pixels from the edge of the channel this pixel lies deepest in, negative inside it.
        const b = (j + margin) * padded + i + margin, e = band ? band.edge[b] / 8 : Infinity, line = e < bankReach ? band.kind[b] : 0, inside = line && e <= 0;
        if (inside && heights[k] <= level + RIVER_LINE_TOLERANCE) {
          heights[k] = level;
          if (line % 2 === 0) lifted[k] = 1;
          if (bed) bed[k] = depthAt(e, band.deep[b]);
          continue;
        }
        if ((outline[a] * (1 - fx) + outline[a + 1] * fx) * (1 - fy) + (outline[a + gw] * (1 - fx) + outline[a + gw + 1] * fx) * fy >= -LOWERED_GROWTH &&
          Math.min(heights[k], before - ((lift[a] * (1 - fx) + lift[a + 1] * fx) * (1 - fy) + (lift[a + gw] * (1 - fx) + lift[a + gw + 1] * fx) * fy)) <=
          level + NORMALIZE_SURFACE_TOLERANCE) {
          // The coarse land cover picks out the water. Its full lift draws the shoreline, since the lowering fades from one cell out and would trace the cells' squares.
          heights[k] = level;
          lifted[k] = 1;
          if (bed && inside) bed[k] = depthAt(e, band.deep[b]);
        } else if (heights[k] > level && heights[k] <= level + LEVEL_WATER_TOLERANCE && heights[k] <= channelSurface(channel, a, gw, fx, fy) + CHANNEL_SURFACE_TOLERANCE) {
          // NOAA still gives these their beds.
          heights[k] = level;
        } else if (before > level + guard && heights[k] < level + guard) {
          heights[k] = level + guard;
        } else if (before > level && heights[k] < level &&
          (wet[a] * (1 - fx) + wet[a + 1] * fx) * (1 - fy) + (wet[a + gw] * (1 - fx) + wet[a + gw + 1] * fx) * fy < -LOWERED_GROWTH) {
          // At small height scales the guard spans whole plains. Land away from the planned water keeps its height instead of drowning in lowering spilled from rivers.
          heights[k] = before;
        }
        // A channel as wide as the mapped water it runs in leaves that water's banks as they are.
        if (line && line <= 4 && heights[k] > level) {
          // A bank takes away no more than the channel cut, which keeps valley walls whole. Inside the channel, land left too high to cut slopes down to it.
          const rise = e * GAME_METERS_PER_PIXEL * RIVER_BANK_GRADE / scale;
          if (rise < RIVER_LINE_TOLERANCE) heights[k] = Math.max(Math.min(heights[k], level + guard + rise), heights[k] - (RIVER_LINE_TOLERANCE - rise));
        }
      }
      if (onProgress && j % ROW_BATCH === ROW_BATCH - 1) await onProgress((j + 1) / height);
    }
    if (band) {
      // Decided on the channels as cut, so a long stretch left high isn't eaten away from its ends.
      const waterWithin = (i, j, dx, dy) => {
        for (let s = 1; s <= RIVER_BREACH; s++) {
          const x = i + dx * s, y = j + dy * s;
          if (x < 0 || y < 0 || x >= width || y >= height || band.edge[(y + margin) * padded + x + margin] > 0) return false;
          if (heights[y * width + x] <= level) return true;
        }
        return false;
      };
      const breach = [];
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const k = j * width + i, b = (j + margin) * padded + i + margin;
          if (band.edge[b] > 0 || !band.kind[b] || heights[k] <= level) continue;
          if (waterWithin(i, j, 1, 0) && waterWithin(i, j, -1, 0) || waterWithin(i, j, 0, 1) && waterWithin(i, j, 0, -1) ||
            waterWithin(i, j, 1, 1) && waterWithin(i, j, -1, -1) || waterWithin(i, j, 1, -1) && waterWithin(i, j, -1, 1)) breach.push(k, b);
        }
      }
      for (let q = 0; q < breach.length; q += 2) {
        const k = breach[q], b = breach[q + 1];
        heights[k] = level;
        if (band.kind[b] % 2 === 0) lifted[k] = 1;
        if (bed) bed[k] = depthAt(band.edge[b] / 8, band.deep[b]);
      }
    }
    if (!beds) return lifted;
    return {lifted: lifted, bed: bed, band: band ? {edge: band.edge, margin: margin} : null};
  }

  // The selected river channels around a grid of output pixels x0 to x0 + width - 1 and y0 to y0 + height - 1, worked out margin pixels past its edges
  // so that a patch sees the channels just outside it the way the whole map does. Each segment of each course marks the pixels within its half width
  // plus reach pixels by their exact distance to it. Returns, on the grid padded by margin on every side:
  // edge, each pixel's distance in eighths of a pixel to the edge of the channel it lies deepest in, negative inside it,
  // kind, that channel's line class from the plan, or that plus 2 where the channel is as wide as the mapped water it runs in,
  // and with beds, deep, that channel's full depth in eighths of an in-game meter.
  // A channel over mapped water is as wide as the water around it, if that's wider, since a circle as wide as the water's nearest shore stays in the water.
  // Toward its end a channel narrows and gets shallower, by the course's taper.
  function channelBand(plan, x0, y0, width, height, outputWidth, outputHeight, margin, reach, beds) {
    const {lines, halfWidths, measured, lineClass, gw, gh} = plan;
    const W = width + 2 * margin, H = height + 2 * margin, n = W * H, ox = x0 - margin, oy = y0 - margin;
    const sx = (gw - 1) / (outputWidth - 1), sy = (gh - 1) / (outputHeight - 1), cellPixels = ((outputWidth - 1) / (gw - 1) + (outputHeight - 1) / (gh - 1)) / 2;
    const edge = new Int16Array(n).fill(BAND_FAR), kind = new Uint8Array(n), deep = beds ? new Uint8Array(n) : null;
    for (const {points, drawn, river, taper, navigable} of lines) {
      // The channel is drawn along its course as smoothed for its width. Cells are looked up on the course itself, as riverGrid marked them.
      const at = drawn || points, count = points.length / 2;
      for (let p = 1; p < count;) {
        const c = courseCell(points[2 * p - 2], points[2 * p - 1], sx, sy, gw, gh), t = taper ? (taper[p - 1] + taper[p]) / 2 : 1, cls = lineClass[c];
        // Over mapped water wider than the channel, the channel takes the water's width, and its kind goes up by 2: 5 at the level, 6 lowered.
        const base = Math.max(halfWidths[river], navigable ? (navigable[p - 1] + navigable[p]) / 2 : 0);
        const visible = cls >= 3 ? (measured[c] - 1) * cellPixels : 0, own = base * t;
        const half = Math.min(RIVER_MAX_HALF_WIDTH, Math.max(own, visible));
        // Wide channels take longer chords of their smoothed course, which stay well inside them.
        const q = Math.min(count - 1, p - 1 + Math.max(1, Math.floor(half / 4)));
        if (cls && half > 0) {
          const ax = at[2 * (p - 1)] - ox, ay = at[2 * (p - 1) + 1] - oy, bx = at[2 * q] - ox, by = at[2 * q + 1] - oy;
          const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy || 1, far = half + reach;
          const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - far)), i1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + far));
          const j0 = Math.max(0, Math.floor(Math.min(ay, by) - far)), j1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + far));
          const k2 = cls + (visible > own ? 2 : 0);
          const full = beds ? Math.min(255, Math.round(8 * t * Math.min(beds.max, Math.max(beds.min, beds.ratio * 2 * Math.max(base, visible) * GAME_METERS_PER_PIXEL)))) : 0;
          for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
              const s = Math.max(0, Math.min(1, ((i - ax) * dx + (j - ay) * dy) / length2));
              const e = Math.hypot(i - ax - dx * s, j - ay - dy * s) - half;
              if (e > reach) continue;
              const code = Math.round(8 * e), k = j * W + i;
              if (code < edge[k]) {
                edge[k] = code;
                kind[k] = k2;
                if (deep) deep[k] = full;
              }
            }
          }
        }
        p = q + 1;
      }
    }
    return {edge: edge, kind: kind, deep: deep};
  }

  // How far each point of each selected course is from where its channel ends, in shares of RIVER_TAPER pixels kept between RIVER_TAPER_MIN and 1,
  // set on plan.lines as taper. A channel ends at a course's head or dead end, where no other course goes on from it or runs past,
  // and where its water stops, too high to lower. It doesn't end at the edge of the map, or where it runs into a lake.
  // width, height: the output's.
  function courseTaper(plan, width, height) {
    const {lines, lineClass, kept, halfWidths, cover, gw, gh} = plan, sx = (gw - 1) / (width - 1), sy = (gh - 1) / (height - 1);
    const cellOf = (x, y) => courseCell(x, y, sx, sy, gw, gh), cellPixels = ((width - 1) / (gw - 1) + (height - 1) / (gh - 1)) / 2;
    const arcs = lines.map(({points}) => {
      const arc = new Float64Array(points.length / 2);
      for (let i = 1; i < arc.length; i++) arc[i] = arc[i - 1] + Math.hypot(points[2 * i] - points[2 * i - 2], points[2 * i + 1] - points[2 * i - 1]);
      return arc;
    });
    // Course ends within a pixel of each other are one node.
    const nodes = [], nodeAt = new Map();
    const nodeOf = (x, y) => {
      const kx = Math.round(x), ky = Math.round(y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const id of nodeAt.get((kx + dx) + ',' + (ky + dy)) || []) if (Math.hypot(nodes[id].x - x, nodes[id].y - y) <= 1) return id;
        }
      }
      nodes.push({x: x, y: y, lines: []});
      nodeAt.set(kx + ',' + ky, (nodeAt.get(kx + ',' + ky) || []).concat(nodes.length - 1));
      return nodes.length - 1;
    };
    const ends = lines.map(({points}, l) => {
      const last = points.length - 2, pair = [nodeOf(points[0], points[1]), nodeOf(points[last], points[last + 1])];
      pair.forEach(id => nodes[id].lines.push(l));
      return pair;
    });
    // Segments by 8-pixel cell, to find another course running past an end.
    const grid = new Map(), G = 8;
    lines.forEach(({points}, l) => {
      for (let i = 1; i < points.length / 2; i++) {
        const key = Math.floor((points[2 * i - 2] + points[2 * i]) / 2 / G) + ',' + Math.floor((points[2 * i - 1] + points[2 * i + 1]) / 2 / G);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(l, i);
      }
    });
    // A navigable river's channel is as wide as it gets in the lowlands.
    const widest = halfWidths.map((w, r) => Math.max(w, plan.navigable ? plan.navigable[r] : 0));
    const reachCells = Math.ceil(widest.reduce((m, w) => Math.max(m, w), RIVER_END_REACH) / G);
    const passesNear = node => {
      const gx = Math.floor(node.x / G), gy = Math.floor(node.y / G);
      for (let dy = -reachCells - 1; dy <= reachCells + 1; dy++) {
        for (let dx = -reachCells - 1; dx <= reachCells + 1; dx++) {
          const list = grid.get((gx + dx) + ',' + (gy + dy)) || [];
          for (let q = 0; q < list.length; q += 2) {
            const l = list[q], i = list[q + 1], pts = lines[l].points;
            if (node.lines.includes(l)) continue;
            const ax = pts[2 * i - 2], ay = pts[2 * i - 1], bx = pts[2 * i] - ax, by = pts[2 * i + 1] - ay;
            const s = Math.max(0, Math.min(1, ((node.x - ax) * bx + (node.y - ay) * by) / (bx * bx + by * by || 1)));
            // A tributary's end inside a wider channel joins it, though smoothing moved that channel's course off the end.
            if (Math.hypot(node.x - ax - bx * s, node.y - ay - by * s) <= Math.max(RIVER_END_REACH, widest[lines[l].river])) return true;
          }
        }
      }
      return false;
    };
    // A course ending at a lake or the sea goes on into it: that water isn't the course's own, carved with lineClass, but it is water.
    const atWater = node => {
      const c = cellOf(node.x, node.y), x = c % gw, y = (c - x) / gw;
      for (let v = Math.max(0, y - 1); v <= Math.min(gh - 1, y + 1); v++) {
        for (let u = Math.max(0, x - 1); u <= Math.min(gw - 1, x + 1); u++) {
          const d = v * gw + u;
          if (!lineClass[d] && (kept[d] > 0 || (cover && (cover[d] === LC_WATER || cover[d] === LC_NO_DATA)))) return true;
        }
      }
      return false;
    };
    // Distance from each node to the nearest channel end along the courses, up to RIVER_TAPER.
    const dist = new Float64Array(nodes.length).fill(Infinity), queue = [];
    nodes.forEach((node, id) => {
      const atEdge = node.x < 2 || node.y < 2 || node.x > width - 3 || node.y > height - 3;
      if (node.lines.length === 1 && !atEdge && !passesNear(node) && !atWater(node)) {
        dist[id] = 0;
        queue.push(id);
      }
    });
    while (queue.length) {
      const id = queue.shift();
      for (const l of nodes[id].lines) {
        const other = ends[l][0] === id ? ends[l][1] : ends[l][0], d = dist[id] + arcs[l][arcs[l].length - 1];
        if (d < dist[other] && d < RIVER_TAPER) {
          dist[other] = d;
          queue.push(other);
        }
      }
    }
    lines.forEach((line, l) => {
      const arc = arcs[l], count = arc.length, last = arc[count - 1], taper = new Float32Array(count);
      // Where the water stops along a course, not counting a lake, which keeps it.
      const state = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const c = cellOf(line.points[2 * i], line.points[2 * i + 1]);
        state[i] = lineClass[c] ? 1 : kept[c] ? 2 : 0;
      }
      // A dry stretch shorter than a cell is a course grazing a neighbouring cell, not water stopping.
      for (let i = 0; i < count;) {
        let j = i;
        while (j < count && state[j] === state[i]) j++;
        if (state[i] === 0 && arc[j - 1] - arc[i] < cellPixels && i > 0 && j < count) state.fill(1, i, j);
        i = j;
      }
      const cut = new Float64Array(count).fill(Infinity);
      for (let i = 1; i < count; i++) cut[i] = state[i] === 1 && state[i - 1] === 0 ? 0 : state[i] === 1 ? cut[i - 1] + arc[i] - arc[i - 1] : Infinity;
      for (let i = count - 2; i >= 0; i--) cut[i] = Math.min(cut[i], state[i] === 1 && state[i + 1] === 0 ? 0 : state[i] === 1 ? cut[i + 1] + arc[i + 1] - arc[i] : Infinity);
      for (let i = 0; i < count; i++) {
        const s = Math.min(dist[ends[l][0]] + arc[i], dist[ends[l][1]] + last - arc[i], cut[i]);
        taper[i] = Math.max(RIVER_TAPER_MIN, Math.min(1, s / RIVER_TAPER));
      }
      line.taper = taper;
    });
  }

  // The half width in output pixels a navigable river's channel widens to at each point of its course, set on plan.lines as navigable:
  // all of it where the river runs at most NAVIGABLE_ELEVATION real meters above the water level, by its lift, fading out NAVIGABLE_FADE higher.
  // Rivers that aren't navigable get none. width, height: the output's.
  function courseNavigable(plan, width, height) {
    const {lines, lift, navigable, gw, gh} = plan, sx = (gw - 1) / (width - 1), sy = (gh - 1) / (height - 1);
    for (const line of lines) {
      if (!(navigable[line.river] > 0)) continue;
      const count = line.points.length / 2, wide = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const above = lift[courseCell(line.points[2 * i], line.points[2 * i + 1], sx, sy, gw, gh)];
        wide[i] = navigable[line.river] * Math.max(0, Math.min(1, (NAVIGABLE_ELEVATION + NAVIGABLE_FADE - above) / NAVIGABLE_FADE));
      }
      line.navigable = wide;
      // Where it widens, the channel follows its course smoothed over its navigable width, as riverGrid smooths every course over its own width,
      // so it doesn't copy bends narrower than itself. Its ends stay put, so it still meets the courses it joins.
      const sigma = RIVER_COURSE_SMOOTHING * 2 * navigable[line.river], reach = Math.ceil(3 * sigma), pts = line.points, drawn = Float64Array.from(pts);
      for (let i = 0; i < count; i++) {
        if (!wide[i]) continue;
        let x = 0, y = 0, w = 0;
        for (let j = Math.max(0, i - reach); j <= Math.min(count - 1, i + reach); j++) {
          const g = Math.exp(-((j - i) ** 2) / (2 * sigma * sigma));
          x += g * pts[2 * j];
          y += g * pts[2 * j + 1];
          w += g;
        }
        const hold = Math.min(1, i / sigma, (count - 1 - i) / sigma) * wide[i] / navigable[line.river];
        drawn[2 * i] += (x / w - pts[2 * i]) * hold;
        drawn[2 * i + 1] += (y / w - pts[2 * i + 1]) * hold;
      }
      line.drawn = drawn;
    }
  }

  // Shores of the water, after smoothing has blurred land into them. The first land pixel sits half an in-game meter above the water level
  // and land rises a meter per pixel from there, blending into the terrain over SHORE_BAND pixels. Water is at most SHORE_WATER_SLOPE in-game meters
  // per pixel deep from its shore. Where the planned water's shore, from the channels' exact distances and the lowered water's outline, agrees with
  // the water there is to within a pixel, it places the shore to a fraction of a pixel, so the game draws the waterline where the water is instead of
  // along a staircase of pixels. Elsewhere near it the distance to the actual water or land decides, so a bank the plan left dry is shaped as a bank.
  // band: as applyWaterPlan returns it, or null. waterLevel: real meters, the game's water surface.
  function shapeShores(heights, width, height, plan, band, waterLevel, scale) {
    const {outline, gw, gh} = plan, sx = (gw - 1) / (width - 1), sy = (gh - 1) / (height - 1), n = width * height;
    const cellPixels = ((width - 1) / (gw - 1) + (height - 1) / (gh - 1)) / 2, padded = band ? width + 2 * band.margin : 0;
    // Chamfer distances in thirds of a pixel, from land to the nearest water and from water to the nearest land, up to the band.
    const cap = Math.ceil(3 * (SHORE_BAND + 2)), toWater = new Uint8Array(n), toLand = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const wet = heights[k] <= waterLevel;
      toWater[k] = wet ? 0 : cap;
      toLand[k] = wet ? cap : 0;
    }
    chamfer(toWater, width, height);
    chamfer(toLand, width, height);
    for (let j = 0; j < height; j++) {
      const v = j * sy, r = Math.min(Math.floor(v), gh - 2), fy = v - r;
      for (let i = 0; i < width; i++) {
        const u = i * sx, c = Math.min(Math.floor(u), gw - 2), fx = u - c, a = r * gw + c, k = j * width + i;
        let e = -((outline[a] * (1 - fx) + outline[a + 1] * fx) * (1 - fy) + (outline[a + gw] * (1 - fx) + outline[a + gw + 1] * fx) * fy + LOWERED_GROWTH) * cellPixels;
        if (band) e = Math.min(e, band.edge[(j + band.margin) * padded + i + band.margin] / 8);
        // Only the planned water's shores: the sea and lakes at the level keep their coasts.
        if (e > SHORE_BAND + 1.5) continue;
        if (heights[k] > waterLevel) {
          // Land: from the shore to its pixel's centre is half a pixel less than to the nearest water pixel's centre.
          // Land the plan counted as water, like a stretch of channel too high to cut, takes its distance to the water there is.
          // Water the plan didn't place, like the sea at a river's mouth, counts from no nearer than a pixel inside the planned shore,
          // so the shaping still fades out by the time the planned shore is too far to shape.
          const real = toWater[k] / 3 - 0.5;
          if (real >= SHORE_BAND + 0.5) continue;
          const d = Math.max(SHORE_MIN_LAND, e >= 0 && Math.abs(e - real) <= 1 ? e : Math.max(real, e - 1)), top = waterLevel + d / scale;
          if (heights[k] > top) {
            const t = Math.max(0, Math.min(1, (d - 0.5) / SHORE_BAND));
            heights[k] = top + (heights[k] - top) * t * t * (3 - 2 * t);
          }
        } else {
          const real = toLand[k] / 3 - 0.5;
          if (real >= SHORE_WATER_REACH) continue;
          const d = e <= 0 && Math.abs(-e - real) <= 1 ? -e : real;
          heights[k] = Math.max(heights[k], waterLevel - SHORE_WATER_SLOPE * d / scale);
        }
      }
    }
  }

  // Two-pass chamfer distance in thirds of a pixel over a Uint8Array that holds 0 at the sources and a cap elsewhere.
  function chamfer(d, width, height) {
    const relax = (k, m, step) => {
      if (d[m] + step < d[k]) d[k] = d[m] + step;
    };
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const k = j * width + i;
        if (!d[k]) continue;
        if (i > 0) relax(k, k - 1, 3);
        if (j > 0) {
          relax(k, k - width, 3);
          if (i > 0) relax(k, k - width - 1, 4);
          if (i < width - 1) relax(k, k - width + 1, 4);
        }
      }
    }
    for (let j = height - 1; j >= 0; j--) {
      for (let i = width - 1; i >= 0; i--) {
        const k = j * width + i;
        if (!d[k]) continue;
        if (i < width - 1) relax(k, k + 1, 3);
        if (j < height - 1) {
          relax(k, k + width, 3);
          if (i < width - 1) relax(k, k + width + 1, 4);
          if (i > 0) relax(k, k + width - 1, 4);
        }
      }
    }
  }

  // Raises water patches under SPECK_PIXELS pixels to the land around them, at least a guard above the water level. Low spots in marsh and polders
  // would otherwise be pits of water scattered over the land. Patches with a pixel keep(k) holds, like mapped water or a channel, stay.
  // Each search stops at SPECK_PIXELS. A patch touching water an earlier search saw belongs to that bigger body, so it stays too.
  function removeSpecks(heights, width, height, waterLevel, guard, keep) {
    const n = width * height, seen = new Uint8Array(n), patch = new Int32Array(SPECK_PIXELS);
    for (let start = 0; start < n; start++) {
      if (seen[start] || !(heights[start] <= waterLevel)) continue;
      let size = 0, head = 0, big = false;
      patch[size++] = start;
      seen[start] = 1;
      while (head < size && !big) {
        const k = patch[head++], x = k % width;
        big = keep(k);
        for (let dy = -1; dy <= 1 && !big; dy++) {
          for (let dx = -1; dx <= 1 && !big; dx++) {
            const m = k + dy * width + dx;
            if (x + dx < 0 || x + dx >= width || m < 0 || m >= n || !(heights[m] <= waterLevel)) continue;
            if (seen[m]) {
              big = patch.subarray(0, size).indexOf(m) < 0;
            } else if (size === SPECK_PIXELS) {
              big = true;
            } else {
              seen[m] = 1;
              patch[size++] = m;
            }
          }
        }
      }
      if (big) continue;
      let ground = Infinity;
      for (let q = 0; q < size; q++) {
        const k = patch[q], x = k % width;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const m = k + dy * width + dx;
            if (x + dx >= 0 && x + dx < width && m >= 0 && m < n && heights[m] > waterLevel) ground = Math.min(ground, heights[m]);
          }
        }
      }
      const top = Math.max(waterLevel + guard, isFinite(ground) ? ground : -Infinity);
      for (let q = 0; q < size; q++) heights[patch[q]] = top;
    }
  }

  // Lowers each pixel with a bed to that depth under level, in real meters, but not below floor. Only lowers, so deeper water from NOAA or layBeds stays.
  // bed: as applyWaterPlan gives it. Returns the deepest bed in in-game meters and whether any stopped at floor.
  function carveBeds(heights, bed, level, scale, floor) {
    let deepest = 0, floored = false;
    for (let k = 0; k < heights.length; k++) {
      if (!bed[k]) continue;
      const target = level - bed[k] / 8 / scale;
      if (target < floor) floored = true;
      heights[k] = Math.min(heights[k], Math.max(floor, target));
      deepest = Math.max(deepest, bed[k] / 8);
    }
    return {deepest: deepest, floored: floored};
  }

  function clampFloor(heights, floor) {
    for (let i = 0; i < heights.length; i++) if (heights[i] < floor) heights[i] = floor;
  }

  // A channel's surface between the four plan cells around a pixel, from the ones that have one, or NaN.
  function channelSurface(channel, a, gw, fx, fy) {
    let sum = 0, weight = 0;
    const corners = [[a, (1 - fx) * (1 - fy)], [a + 1, fx * (1 - fy)], [a + gw, (1 - fx) * fy], [a + gw + 1, fx * fy]];
    for (const [c, w] of corners) {
      if (channel[c] === channel[c]) {
        sum += channel[c] * w;
        weight += w;
      }
    }
    return weight > 0 ? sum / weight : NaN;
  }

  // Lays an estimated bed under water the data gives no depth for, since elevation data only records a water surface.
  // submerge: as for applyBathymetry. surveyed: as applyBathymetry returns it, or null. gameCell: in-game meters per cell.
  // Returns how many cells got a bed in each row. onProgress(fraction): optional, called every ROW_BATCH rows of each pass, and awaited.
  async function layBeds(heights, width, height, submerge, lowered, surveyed, gameCell, scale, onProgress) {
    const {level, top} = submerge, flat = Math.fround(top);
    const sx = surveyed ? (surveyed.width - 1) / (width - 1) : 0, sy = surveyed ? (surveyed.height - 1) / (height - 1) : 0;
    const unsurveyed = (x, y) => !surveyed || !surveyed.grid[Math.round(y * sy) * surveyed.width + Math.round(x * sx)];
    // Chamfer distance to the shore in thirds of a cell, which reaches past the deepest bed.
    const d = new Uint8Array(heights.length);
    for (let i = 0; i < d.length; i++) d[i] = heights[i] <= level ? 255 : 0;
    const beds = new Float64Array(height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!d[i]) continue;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 3);
        if (y > 0) {
          v = Math.min(v, d[i - width] + 3);
          if (x > 0) v = Math.min(v, d[i - width - 1] + 4);
          if (x < width - 1) v = Math.min(v, d[i - width + 1] + 4);
        }
        d[i] = v;
      }
      if (onProgress && y % ROW_BATCH === ROW_BATCH - 1) await onProgress((y + 1) / (2 * height));
    }
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const i = y * width + x;
        if (!d[i]) continue;
        let v = d[i];
        if (x < width - 1) v = Math.min(v, d[i + 1] + 3);
        if (y < height - 1) {
          v = Math.min(v, d[i + width] + 3);
          if (x < width - 1) v = Math.min(v, d[i + width + 1] + 4);
          if (x > 0) v = Math.min(v, d[i + width - 1] + 4);
        }
        d[i] = v;
        if ((lowered && lowered[i]) || (heights[i] === flat && unsurveyed(x, y))) {
          heights[i] = Math.min(heights[i], top - Math.min(BED_MAX_DEPTH, NORMALIZE_GRADE * gameCell * v / 3) / scale);
          beds[y]++;
        }
      }
      if (onProgress && y % ROW_BATCH === 0) await onProgress((2 * height - y) / (2 * height));
    }
    return beds;
  }

  // {step, edges}: the median step, in real meters, from open land up onto forest across forest edges on gentle land, and how many edges it took.
  // ground: real meters on the land cover grid. forest, gentle: nonzero for forest cells and for gentle dry cells.
  // Each edge is read along a row or a column, from the cells reach to 2 reach - 1 out on either side, past where land cover and the tiles blur it.
  // The land's own slope, from the cells 2 reach to 3 reach - 1 out on both sides, is taken out of the step.
  function canopyStep(ground, forest, gentle, gw, gh, reach) {
    const steps = [], depth = 3 * reach, near = new Float64Array(2), far = new Float64Array(2);
    // Sums of the near and far cells from start along e, on a side that is all forest or all open land, or false.
    const side = (start, e, kind, s) => {
      near[s] = far[s] = 0;
      for (let j = 0, i = start; j < depth; j++, i += e) {
        if (!gentle[i] || forest[i] !== kind) return false;
        if (j >= 2 * reach) far[s] += ground[i];
        else if (j >= reach) near[s] += ground[i];
      }
      return true;
    };
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const p = y * gw + x;
        // The edge between p and the cell before it, along the row and down the column.
        for (const [e, before, after] of [[1, x, gw - x], [gw, y, gh - y]]) {
          if (before < depth || after < depth || forest[p] === forest[p - e]) continue;
          const inside = forest[p] ? p : p - e, outside = forest[p] ? p - e : p, out = outside - inside;
          if (!side(inside, -out, 1, 0) || !side(outside, out, 0, 1)) continue;
          // The near means sit 3 reach apart. The slope comes from the reach between near and far on each side.
          steps.push(near[0] - near[1] - 1.5 * (far[0] - near[0] + near[1] - far[1]));
        }
      }
    }
    steps.sort((a, b) => a - b);
    return {step: steps.length ? steps[steps.length >> 1] / reach : NaN, edges: steps.length};
  }

  // Plans the canopy's removal on the land cover grid: the canopy height, and how far each cell is lowered, in real meters.
  // ground: real meters on the grid. cover: land cover classes on it. level, guard: real meters. Land at or below level + guard stays where it is.
  // cellMeters, pixelMeters: real meters per grid cell and per output pixel.
  // Returns null when there is no dry land, else {lower, canopy, edges, blur, reach, ...}: blur is the edge blur's sigma in output pixels,
  // and reach how far it reaches, the margin terrainPatch needs around a patch.
  async function canopyPlan(ground, cover, gw, gh, level, guard, cellMeters, pixelMeters) {
    const n = gw * gh, dry = new Uint8Array(n), forest = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      dry[i] = dryLand(cover[i]) && ground[i] > level ? 1 : 0;
      forest[i] = dry[i] && cover[i] === LC_TREES ? 1 : 0;
      any = any || dry[i] === 1;
    }
    if (!any) return null;
    // Slopes come from the ground blurred over CANOPY_SLOPE_METERS, where a forest's step is under a degree. Water beside a cell is left out of its slope.
    const smooth = ground.slice();
    await smoothLand(smooth, gw, gh, CANOPY_SLOPE_METERS / cellMeters, level);
    const weight = new Float32Array(n), gentle = new Uint8Array(n);
    const rise = (i, a, b) => {
      const ha = dry[a] ? smooth[a] : smooth[i], hb = dry[b] ? smooth[b] : smooth[i];
      return (hb - ha) / Math.max(1, (dry[a] && a !== i ? 1 : 0) + (dry[b] && b !== i ? 1 : 0));
    };
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (!dry[i]) continue;
        const dx = rise(i, x > 0 ? i - 1 : i, x < gw - 1 ? i + 1 : i), dy = rise(i, y > 0 ? i - gw : i, y < gh - 1 ? i + gw : i);
        const slope = Math.atan(Math.hypot(dx, dy) / cellMeters) * 180 / Math.PI;
        const t = Math.max(0, Math.min(1, (slope - CANOPY_FLAT) / (CANOPY_STEEP - CANOPY_FLAT)));
        weight[i] = 1 - t * t * (3 - 2 * t);
        gentle[i] = slope <= CANOPY_FLAT ? 1 : 0;
      }
    }
    // One canopy height for the whole export. A fit per region would follow the hills forests grow on as much as the trees.
    const {step, edges} = canopyStep(ground, forest, gentle, gw, gh, Math.max(1, Math.round(CANOPY_EDGE_METERS / cellMeters)));
    const raw = edges >= CANOPY_MIN_EDGES ? step : edges ? Math.min(CANOPY_DEFAULT, step) : CANOPY_DEFAULT;
    const canopy = raw < CANOPY_MIN ? 0 : Math.min(CANOPY_MAX, raw);
    // The forest is feathered the way the tiles blur its edge. Bilinear upsampling already spreads an edge over a cell, so the blur adds the rest.
    // Water stays out of the blur, so forest keeps its full lowering up to the shore.
    const cellPixels = cellMeters / pixelMeters, feather = Math.max(CANOPY_FEATHER, CANOPY_FEATHER_METERS / pixelMeters);
    const lower = new Float32Array(n);
    for (let i = 0; i < n; i++) lower[i] = dry[i] ? forest[i] * weight[i] : -1;
    await smoothLand(lower, gw, gh, Math.sqrt(Math.max(0, feather * feather - cellPixels * cellPixels / 12)) / cellPixels, -0.5);
    // Water takes the lowering of the land nearest it, so pixels between a shore cell and the water still lose the forest's full canopy.
    // Shares under 1% are the blur's rounding, which would reach land far from any forest.
    distanceTo(dry, gw, gh, lower);
    for (let i = 0; i < n; i++) lower[i] = lower[i] >= 0.01 ? lower[i] * canopy : 0;
    // A blur of half a pixel or less would change nothing.
    const blur = CANOPY_EDGE_BLUR * cellPixels > 0.5 ? CANOPY_EDGE_BLUR * cellPixels : 0;
    return {lower: lower, cover: cover, gw: gw, gh: gh, level: level, guard: guard, canopy: canopy, edges: edges, blur: blur, reach: Math.ceil(3 * blur)};
  }

  // Bilinear sample of a plan grid at output pixel (x, y). Pixels past the grid take its edge.
  function planAt(grid, gw, gh, x, y, sx, sy) {
    const v = Math.min(gh - 1, Math.max(0, y * sy)), r = Math.min(Math.floor(v), gh - 2), fy = v - r;
    const u = Math.min(gw - 1, Math.max(0, x * sx)), c = Math.min(Math.floor(u), gw - 2), fx = u - c, a = r * gw + c;
    return (grid[a] * (1 - fx) + grid[a + 1] * fx) * (1 - fy) + (grid[a + gw] * (1 - fx) + grid[a + gw + 1] * fx) * fy;
  }

  // Whether output pixel (x, y) is dry by land cover, from its nearest cell.
  function planDry(plan, x, y, sx, sy) {
    const {cover, gw, gh} = plan;
    return dryLand(cover[Math.round(Math.min(gh - 1, Math.max(0, y * sy))) * gw + Math.round(Math.min(gw - 1, Math.max(0, x * sx)))]);
  }

  // Lowers each pixel by the plan's lowering. Water, by land cover or at or below the level, stays, and nothing goes below a guard above the level,
  // so lowering makes no new water. Returns how many pixels in each row lost at least half the canopy.
  // The grid covers output pixels x0 to x0 + width - 1 and y0 to y0 + height - 1 of an output outputWidth x outputHeight.
  // onProgress(fraction): optional, called every ROW_BATCH rows, and awaited.
  async function applyCanopy(plan, heights, width, height, x0, y0, outputWidth, outputHeight, onProgress) {
    const {lower, gw, gh, level, guard, canopy} = plan;
    const sx = (gw - 1) / (outputWidth - 1), sy = (gh - 1) / (outputHeight - 1), lowered = new Float64Array(height), floor = level + guard;
    if (!(canopy > 0)) return lowered;
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const k = j * width + i;
        if (!(heights[k] > floor) || !planDry(plan, x0 + i, y0 + j, sx, sy)) continue;
        const drop = planAt(lower, gw, gh, x0 + i, y0 + j, sx, sy);
        if (!(drop > 0)) continue;
        heights[k] = Math.max(heights[k] - drop, floor);
        if (drop >= canopy / 2) lowered[j]++;
      }
      if (onProgress && j % ROW_BATCH === ROW_BATCH - 1) await onProgress((j + 1) / height);
    }
    return lowered;
  }

  // Blurs the land around forest edges with a Gaussian of the plan's blur sigma, fully where the feather is half forest and fading out with it.
  // The land cover's cells place an edge only to within half a cell, so the tiles' sharp step stays beside the feathered lowering. The blur turns it into a slope.
  // It moves no pixel more than the canopy, the most a misplaced edge leaves, so a valley wall or a dike beside a forest keeps its height.
  // Water and land at or below the guard stay out of the blur and as they are. Rows go through a ring of 2 reach + 1 blurred rows, written back in place,
  // so no full-size array is needed. A patch needs a margin of the plan's reach to match the map.
  // The grid covers output pixels x0 to x0 + width - 1 and y0 to y0 + height - 1 of an output outputWidth x outputHeight.
  // onProgress(fraction): optional, called every ROW_BATCH rows, and awaited.
  async function softenEdges(plan, heights, width, height, x0, y0, outputWidth, outputHeight, onProgress) {
    const {lower, gw, gh, level, guard, canopy, blur, reach} = plan;
    if (!(canopy > 0) || !(blur > 0)) return;
    const sx = (gw - 1) / (outputWidth - 1), sy = (gh - 1) / (outputHeight - 1), floor = level + guard, rows = 2 * reach + 1;
    const kernel = new Float32Array(rows), sum = new Float32Array(rows * width), weight = new Float32Array(rows * width);
    const land = new Float32Array(width), value = new Float32Array(width);
    for (let q = 0; q < rows; q++) kernel[q] = Math.exp(-((q - reach) ** 2) / (2 * blur * blur));
    for (let j = 0; j < height + reach; j++) {
      if (j < height) {
        const ring = (j % rows) * width, row = j * width;
        for (let i = 0; i < width; i++) {
          land[i] = heights[row + i] > level && planDry(plan, x0 + i, y0 + j, sx, sy) ? 1 : 0;
          value[i] = land[i] ? heights[row + i] : 0;
        }
        for (let i = 0; i < width; i++) {
          let s = 0, w = 0;
          for (let q = Math.max(0, i - reach), last = Math.min(width - 1, i + reach), c = q - i + reach; q <= last; q++, c++) {
            s += kernel[c] * value[q];
            w += kernel[c] * land[q];
          }
          sum[ring + i] = s;
          weight[ring + i] = w;
        }
      }
      const t = j - reach;
      if (t < 0) continue;
      for (let i = 0; i < width; i++) {
        const k = t * width + i;
        if (!(heights[k] > floor)) continue;
        const f = planAt(lower, gw, gh, x0 + i, y0 + t, sx, sy) / canopy, mix = Math.min(1, 4 * f * (1 - f));
        if (!(mix > 0) || !planDry(plan, x0 + i, y0 + t, sx, sy)) continue;
        let s = 0, w = 0;
        for (let q = Math.max(0, t - reach); q <= Math.min(height - 1, t + reach); q++) {
          s += kernel[q - t + reach] * sum[(q % rows) * width + i];
          w += kernel[q - t + reach] * weight[(q % rows) * width + i];
        }
        if (w > 0) heights[k] = Math.max(floor, heights[k] + mix * Math.max(-canopy, Math.min(canopy, s / w - heights[k])));
      }
      if (onProgress && t % ROW_BATCH === ROW_BATCH - 1) await onProgress((t + 1) / height);
    }
  }

  // Lowers forest on gentle land by the canopy height fitted from its edges and softens what is left of its edges, in real meters,
  // before polders, water normalization and smoothing see the land.
  // heights: real meters, width x height. cover: land cover classes on the gw x gh grid, as landCoverFor gives it.
  // waterLevel: real meters at or below which the map is water. guard: real meters above it that lowered land stays. mpp: real meters per output pixel.
  // onProgress(fraction): optional, called every ROW_BATCH rows, and awaited.
  // Returns {canopy, km2, edges, plan}: the canopy in real meters, the square kilometers that lost at least half of it,
  // how many forest edges measured it, and the plan for terrainPatch, or null.
  async function removeCanopy(heights, width, height, cover, gw, gh, waterLevel, guard, mpp, onProgress) {
    const sx = (gw - 1) / (width - 1), sy = (gh - 1) / (height - 1);
    // Each cell averages the land pixels nearest it. A cell with none sits at the water level.
    const ground = new Float32Array(gw * gh), count = new Uint16Array(gw * gh);
    for (let j = 0; j < height; j++) {
      const row = Math.round(j * sy) * gw;
      for (let i = 0; i < width; i++) {
        const h = heights[j * width + i];
        if (!(h > waterLevel)) continue;
        const c = row + Math.round(i * sx);
        ground[c] += h;
        count[c]++;
      }
    }
    for (let c = 0; c < ground.length; c++) ground[c] = count[c] ? ground[c] / count[c] : waterLevel;
    const plan = await canopyPlan(ground, cover, gw, gh, waterLevel, guard, mpp * (width - 1) / (gw - 1), mpp);
    if (!plan) return {canopy: 0, km2: 0, edges: 0, plan: null};
    // The blur takes most of the time.
    const lowered = await applyCanopy(plan, heights, width, height, 0, 0, width, height, onProgress && (f => onProgress(f / 5)));
    await softenEdges(plan, heights, width, height, 0, 0, width, height, onProgress && (f => onProgress((1 + 4 * f) / 5)));
    return {canopy: plan.canopy, km2: lowered.reduce((sum, n) => sum + n, 0) * mpp * mpp / 1e6, edges: plan.edges, plan: plan};
  }

  // Pixels per side of the cells shapeRelief pools land into, and its blur's sigma in cells. Pooling itself blurs by a cell's width over root 12.
  function reliefCells(sigma) {
    const cell = Math.max(1, Math.floor(sigma / RELIEF_CELL_SIGMA));
    return {cell: cell, sigma: Math.sqrt(Math.max(0, sigma * sigma - cell * cell / 12)) / cell};
  }

  // relief as render takes it, any of {gain, mountain, sigma, waterFade} left out at the RELIEF_ defaults, with its pixel lengths times ratio
  // for a grid ratio times as wide as the output, like analyze's preview.
  function reliefOptions(relief, ratio) {
    const options = Object.assign({gain: RELIEF_GAIN, mountain: RELIEF_MOUNTAIN, sigma: RELIEF_SIGMA, waterFade: RELIEF_WATER_FADE}, relief);
    return Object.assign(options, {sigma: options.sigma * ratio, waterFade: options.waterFade * ratio});
  }

  // Pixels a patch needs around it to come out of shapeRelief as it does in the whole map: the base's blur, then the detail's, and a cell for each lookup.
  function reliefPad(sigma) {
    if (!(sigma > 0)) return 0;
    const {cell, sigma: s} = reliefCells(sigma);
    return (6 * (boxKernel(s).r + 1) + 2) * cell;
  }

  // Splits land into a base, a plane fitted to the land within about sigma pixels, and the detail on it, and scales the detail by a gain that falls
  // as the land gets rougher: gain / (1 + gain * scale * rms / mountain), rms the detail's local root mean square in real meters.
  // Flat land's detail grows up to gain times, a mountain's shrinks toward mountain in-game meters. Water at or below waterLevel stays as it is and out of the base.
  // The gain fades to 1 over waterFade pixels from water, and land above waterLevel plus an in-game meter never goes below that, so no new water appears.
  // options: {gain, mountain, sigma, waterFade} as reliefOptions gives them.
  // x0, y0: optional, the output pixel of the first column and row, so a patch pools into the same cells as the map.
  // Base, detail and gain live on cells a few pixels wide and are interpolated between their centers, so it needs no full-size grid.
  // onProgress(fraction): optional, called every ROW_BATCH rows, and awaited.
  async function shapeRelief(heights, width, height, waterLevel, scale, options, x0, y0, onProgress) {
    const {gain, mountain, sigma, waterFade} = options;
    if (!(sigma > 0)) return;
    const {cell, sigma: s} = reliefCells(sigma), {r, share} = boxKernel(s);
    // Each pixel's cell, its position in cells from the grid's middle, and along each axis the two cell centers it lies between with its share of the way.
    const axis = (count, origin) => {
      const first = Math.floor(origin / cell), cells = Math.floor((origin + count - 1) / cell) - first + 1;
      const own = new Int32Array(count), at = new Float32Array(count), lo = new Int32Array(count), hi = new Int32Array(count), t = new Float32Array(count), size = new Float32Array(cells);
      for (let i = 0; i < count; i++) {
        own[i] = Math.floor((origin + i) / cell) - first;
        at[i] = (origin + i + 0.5) / cell - first - cells / 2;
        size[own[i]]++;
        // Past the outer centers the line through the last two goes on, so a slope keeps its grade out to the map's edge.
        const u = at[i] + cells / 2 - 0.5;
        lo[i] = Math.max(0, Math.min(cells - 2, Math.floor(u)));
        hi[i] = Math.min(cells - 1, lo[i] + 1);
        t[i] = cells > 1 ? u - lo[i] : 0;
      }
      return {own: own, at: at, lo: lo, hi: hi, t: t, size: size, cells: cells};
    };
    const X = axis(width, x0 || 0), Y = axis(height, y0 || 0), cw = X.cells, ch = Y.cells, n = cw * ch;
    const lerp = (grid, i, j) => {
      const a = Y.lo[j] * cw, b = Y.hi[j] * cw, c = X.lo[i], d = X.hi[i], tx = X.t[i];
      const upper = grid[a + c] + (grid[a + d] - grid[a + c]) * tx, lower = grid[b + c] + (grid[b + d] - grid[b + c]) * tx;
      return upper + (lower - upper) * Y.t[j];
    };
    const report = async (pass, j) => {
      if (onProgress && j % ROW_BATCH === ROW_BATCH - 1) await onProgress((pass + (j + 1) / height) / 3);
    };
    // The land's moments in each cell, heights from h0 to keep the products small: count, x, y, height, x x, y y, x y, x height, y height.
    const h0 = isFinite(waterLevel) ? waterLevel : 0, m = [];
    for (let q = 0; q < 9; q++) m.push(new Float32Array(n));
    const [weight, sx, sy, sh, sxx, syy, sxy, sxh, syh] = m;
    for (let j = 0; j < height; j++) {
      const row = Y.own[j] * cw, v = Y.at[j];
      for (let i = 0; i < width; i++) {
        const h = heights[j * width + i];
        if (!(h > waterLevel)) continue;
        const c = row + X.own[i], u = X.at[i], e = h - h0;
        weight[c]++;
        sx[c] += u;
        sy[c] += v;
        sh[c] += e;
        sxx[c] += u * u;
        syy[c] += v * v;
        sxy[c] += u * v;
        sxh[c] += u * e;
        syh[c] += v * e;
      }
      await report(0, j);
    }
    // A cell with a row's worth of water holds a shore or a channel. Fewer water pixels are pits, which removeSpecks fills later.
    const water = new Uint8Array(n);
    for (let c = 0; c < n; c++) water[c] = X.size[c % cw] * Y.size[(c / cw) | 0] - weight[c] >= cell ? 1 : 0;
    for (const grid of m) for (let pass = 0; pass < 3; pass++) boxSum(grid, cw, ch, r, share);
    // The base is the plane fitted to the land around each cell, at the cell's center. Near water or the map's edge the land lies to one side,
    // where a plain mean would sit up or down the slope and turn the slope itself into detail.
    const ridge = RELIEF_RIDGE * s * s, base = sh;
    for (let c = 0; c < n; c++) {
      const w = weight[c];
      if (!(w > 0)) {
        base[c] = h0;
        continue;
      }
      const ax = sx[c] / w, ay = sy[c] / w, ah = sh[c] / w;
      const vxx = sxx[c] / w - ax * ax + ridge, vyy = syy[c] / w - ay * ay + ridge, vxy = sxy[c] / w - ax * ay;
      const cx = sxh[c] / w - ax * ah, cy = syh[c] / w - ay * ah, det = vxx * vyy - vxy * vxy;
      const gx = (vyy * cx - vxy * cy) / det, gy = (vxx * cy - vxy * cx) / det;
      base[c] = h0 + ah + gx * (c % cw + 0.5 - cw / 2 - ax) + gy * (((c / cw) | 0) + 0.5 - ch / 2 - ay);
    }
    // The detail's local mean square, land only, blurred like the base so a ridge and the valley beside it share one gain.
    const gains = sx.fill(0);
    for (let j = 0; j < height; j++) {
      const row = Y.own[j] * cw;
      for (let i = 0; i < width; i++) {
        const h = heights[j * width + i];
        if (h > waterLevel) gains[row + X.own[i]] += (h - lerp(base, i, j)) ** 2;
      }
      await report(1, j);
    }
    for (let pass = 0; pass < 3; pass++) boxSum(gains, cw, ch, r, share);
    // Cells from each cell's center to the nearest water cell's center. Half a cell less reaches that cell's edge.
    const shore = distanceTo(water, cw, ch);
    for (let c = 0; c < n; c++) {
      const rms = weight[c] > 0 ? Math.sqrt(Math.max(0, gains[c] / weight[c])) : 0;
      const g = gain / (1 + gain * scale * rms / mountain), t = waterFade > 0 ? Math.min(1, Math.max(0, (shore[c] - 0.5) * cell / waterFade)) : 1;
      gains[c] = 1 + (g - 1) * t * t * (3 - 2 * t);
    }
    const guard = waterLevel + 1 / scale;
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const k = j * width + i, h = heights[k];
        if (!(h > waterLevel)) continue;
        const b = lerp(base, i, j);
        heights[k] = Math.max(b + lerp(gains, i, j) * (h - b), Math.min(h, guard));
      }
      await report(2, j);
    }
  }

  // Coarse pass for live feedback: extremes and water surfaces, without fetching full-resolution tiles.
  // limits(peak): given the highest point in meters, the {floor, ceiling} in meters that heights are clamped into.
  // submerge(water, floodShare, areaKm2): given the water surfaces found, the {level, top} in meters for applyBathymetry, or null.
  // smoothing: as for render, in pixels of an image outputWidth wide.
  // normalizeWater(water, floodShare, areaKm2): given the water surfaces found, the real height rivers and lakes above it are lowered to, or null.
  // normalizeLift: as planWater's maxLift. canopy, relief: as for render.
  async function analyze(options) {
    const {bounds, aspect, limits, submerge, smoothing, outputWidth, normalizeWater, normalizeLift} = options;
    const region = boundsToRegion(bounds);
    const width = Math.max(2, Math.round(PREVIEW_SIZE * Math.min(1, aspect)));
    const height = Math.max(2, Math.round(PREVIEW_SIZE * Math.min(1, 1 / aspect)));
    const heights = await sampleRegion(region, width, height, pickZoom(region.x1 - region.x0, width, 1), function () {});
    let cover = null, landCover = null;
    try {
      cover = await fetchImageServer(LANDCOVER_URL, region, width, height, 'U8', 'RSP_NearestNeighbor');
      landCover = {};
      for (let i = 0; i < cover.length; i++) landCover[cover[i]] = (landCover[cover[i]] || 0) + 1 / cover.length;
    } catch (e) {
      cover = null;
    }
    const peak = highest(heights);
    const {floor, ceiling, scale} = limits(peak);
    const relief = options.relief ? options.relief(scale) : null;
    const gameCell = GAME_METERS_PER_PIXEL * (outputWidth - 1) / (width - 1);
    let extremes = clampAndMeasure(heights, floor, ceiling);
    const areas = rowAreas(region, width, height);
    const {surfaces: water, floodShare} = findWaterSurfaces(heights, width, height, areas, floor, ceiling, cover);
    const areaKm2 = areas.reduce((sum, a) => sum + a, 0) * width / 1e6;
    const sea = submerge ? submerge(water, floodShare, areaKm2) : null;
    // The level comes from the map as it is. Lowering water onto it can't change which level that is.
    const surface = normalizeWater && cover ? normalizeWater(water, floodShare, areaKm2) : null;
    // The preview's land cover is on its own pixels.
    const level = sea ? sea.level : surface !== null && isFinite(surface) ? surface : -Infinity;
    const canopy = options.canopy && cover ? await removeCanopy(heights, width, height, cover, width, height, level, 1 / scale, groundWidth(region) / (width - 1)) : null;
    let plan = null, lifted = null;
    if (surface !== null && isFinite(surface)) {
      plan = await planWater(heights, cover, width, height, areas, gameCell, scale, surface, null, normalizeLift);
      if (plan) lifted = await applyWaterPlan(plan, heights, width, height, 0, 0, width, height);
    }
    let bathymetry = null;
    if (sea) {
      const depths = await applyBathymetry(heights, width, height, region, sea, null, lifted);
      bathymetry = depths.note;
      await layBeds(heights, width, height, sea, lifted, depths.surveyed, gameCell, scale);
    }
    if (relief) await shapeRelief(heights, width, height, sea ? sea.level : plan ? surface : -Infinity, scale, reliefOptions(relief, (width - 1) / (outputWidth - 1)));
    if (smoothing) await smoothLand(heights, width, height, smoothing * (width - 1) / (outputWidth - 1), sea ? sea.level : -Infinity);
    if (sea || smoothing || lifted || canopy || relief) extremes = clampAndMeasure(heights, floor, ceiling);
    return {
      min: extremes.lo, max: extremes.hi, peak: peak, groundWidth: groundWidth(region), areaKm2: areaKm2,
      water: water, floodShare: floodShare, bathymetry: bathymetry, normalized: plan ? plan.stats : null,
      landCover: landCover, centerLat: yToLat((region.y0 + region.y1) / 2)
    };
  }

  // limits(peak): as for analyze. range(lo, hi): given the clamped data's extremes in meters, returns the {min, max} that map to black and white.
  // submerge: the {level, top} in meters for applyBathymetry, or null. smoothing: the blur's sigma in pixels, or 0.
  // waterLevel: real meters at or below which the map is water. That water stays out of the smoothing. Dry land below the level is raised above it.
  // waterFromRiver: the level is a river's lowest point. All dry land below it is raised.
  // normalizeWater: lower rivers and lakes onto the water surface limits gives, in real meters as waterSurface. normalizeLift: as planWater's maxLift.
  // rivers: optional, the rivers for normalization as for riverGrid, selected or left out. riverSlack: optional, real meters Natural Earth's courses may stray from their river.
  // riverBeds: optional, {ratio, min, max} as applyWaterPlan's beds, which cuts the selected rivers' beds below the water down to the real meters limits gives as riverFloor.
  // cover: optional, land cover as landCover gives it for this output.
  // canopy: whether to take the forest canopy the elevation tiles measure off the ground under it.
  // relief(scale): optional, given the height scale limits picked, {gain, mountain} as shapeRelief takes them, which scales the detail on the land:
  // flat land's up, mountains' down. Or null to leave it.
  // width and height are the region's, north up. northLeft turns the image a quarter left.
  async function render(options) {
    const {bounds, width, height, bitDepth, range, limits, submerge, smoothing, waterLevel, waterFromRiver, northLeft, normalizeWater, normalizeLift, rivers, riverSlack, riverBeds} = options;
    const onProgress = options.onProgress || function () {};
    const onStage = options.onStage || function () {};
    const region = boundsToRegion(bounds);
    const zoom = pickZoom(region.x1 - region.x0, width, 2);

    const heights = await sampleRegion(region, width, height, zoom, onProgress);
    // limits sees the peak before normalization and smoothing, the same one the preview measures.
    const peak = highest(heights);
    const {floor, ceiling, scale, waterSurface, riverFloor} = limits(peak);
    const relief = options.relief ? options.relief(scale) : null;
    let normalized = null, lifted = null, cover = options.cover || null, polders = null, lowLand = null, plan = null, bed = null, band = null, canopy = null;
    // Forest canopy comes off first, so polders, water normalization and smoothing see the ground under the trees.
    if (options.canopy) {
      try {
        cover = cover || await landCoverFor(region, width, height, onStage);
        const {width: gw, height: gh} = rasterSize(width, height);
        onStage('Removing forest canopy...', 0);
        await yieldToPage();
        const removed = await removeCanopy(heights, width, height, cover, gw, gh, waterLevel, 1 / scale, groundWidth(region) / (width - 1), f => {
          onStage('Removing forest canopy...', f);
          return yieldToPage();
        });
        canopy = {meters: Number(removed.canopy.toFixed(1)), edges: removed.edges, km2: removed.km2 > 0 ? Math.max(0.1, Number(removed.km2.toFixed(1))) : 0};
      } catch (e) {
        canopy = 'unavailable (' + e.message + ')';
      }
    }
    if (isFinite(waterLevel) && heights.some(h => h <= waterLevel)) {
      try {
        cover = cover || await landCoverFor(region, width, height, onStage);
        const {width: gw, height: gh} = rasterSize(width, height), areas = rowAreas(region, width, height);
        polders = raisePolders(polderPlan(cover, gw, gh, waterLevel, scale, groundWidth(region) / (width - 1), groundWidth(region) / (gw - 1), waterFromRiver), heights, width, height, 0, 0, width, height).reduce((sum, n, y) => sum + n * areas[y], 0) / 1e6;
      } catch (e) {
        polders = 'unavailable (' + e.message + ')';
      }
    }
    if (normalizeWater && isFinite(waterSurface)) {
      try {
        plan = await planWaterFor(region, width, height, heights, scale, waterSurface, onStage, rivers, riverSlack, cover, normalizeLift);
        if (plan) {
          onStage('Normalizing water...', 0);
          await yieldToPage();
          const withBeds = riverBeds && plan.lines && plan.lines.length ? riverBeds : null;
          const applied = await applyWaterPlan(plan, heights, width, height, 0, 0, width, height, f => {
            onStage('Normalizing water...', f);
            return yieldToPage();
          }, withBeds);
          lifted = withBeds ? applied.lifted : applied;
          bed = withBeds ? applied.bed : null;
          band = withBeds ? applied.band : null;
          normalized = plan.stats;
        }
      } catch (e) {
        normalized = 'unavailable (' + e.message + ')';
      }
    }
    // After normalization, which fills low land beside the sea along with tidal channels, and before water depths. Normalized water and channels stay.
    if (isFinite(waterLevel) && heights.some(h => h <= waterLevel)) {
      try {
        const areas = rowAreas(region, width, height), padded = band ? width + 2 * band.margin : 0;
        const water = k => {
          const i = k % width, j = (k - i) / width;
          return (lifted !== null && lifted[k] === 1) || (band !== null && band.edge[(j + band.margin) * padded + i + band.margin] <= 0);
        };
        lowLand = (await raiseLowLand(heights, width, height, region, waterLevel, waterLevel + 1 / scale, onStage, water)).reduce((sum, n, y) => sum + n * areas[y], 0) / 1e6;
      } catch (e) {
        lowLand = 'unavailable (' + e.message + ')';
      }
    }
    let bathymetry = null;
    if (submerge) {
      onStage('Fetching water depths...');
      const depths = await applyBathymetry(heights, width, height, region, submerge, f => onStage('Fetching water depths...', f), lifted);
      bathymetry = depths.note;
      onStage('Laying water beds...', 0);
      await yieldToPage();
      const beds = await layBeds(heights, width, height, submerge, lifted, depths.surveyed, GAME_METERS_PER_PIXEL, scale, f => {
        onStage('Laying water beds...', f);
        return yieldToPage();
      });
      const areas = rowAreas(region, width, height), bedKm2 = beds.reduce((sum, cells, y) => sum + cells * areas[y], 0) / 1e6;
      if (bedKm2 >= 0.05) bathymetry += ', beds estimated under ' + bedKm2.toFixed(1) + ' km2 of water without depth data';
    }
    // River beds go below the floor water is otherwise clamped to, down to riverFloor. Everything else is clamped first.
    if (bed) {
      clampFloor(heights, floor);
      const carved = carveBeds(heights, bed, plan.level, scale, isFinite(riverFloor) ? riverFloor : floor);
      if (normalized && normalized.rivers) Object.assign(normalized.rivers, carved);
      bed = null;
    }
    // After normalization, which leaves every planned water at or under the level, so shaping can tell land from water by height alone.
    if (relief) {
      onStage('Shaping relief...', 0);
      await yieldToPage();
      await shapeRelief(heights, width, height, waterLevel, scale, reliefOptions(relief, 1), 0, 0, f => {
        onStage('Shaping relief...', f);
        return yieldToPage();
      });
    }
    if (smoothing) {
      onStage('Smoothing terrain...', 0);
      await yieldToPage();
      await smoothLand(heights, width, height, smoothing, waterLevel, f => {
        onStage('Smoothing terrain...', f);
        return yieldToPage();
      });
    }
    // Shores go after smoothing, which blurs the land behind them into them. Then pits of water left in the land are filled.
    if (plan && isFinite(waterLevel)) {
      onStage('Shaping shores...');
      await yieldToPage();
      shapeShores(heights, width, height, plan, band, waterLevel, scale);
      const {width: gw, height: gh} = rasterSize(width, height), csx = (gw - 1) / (width - 1), csy = (gh - 1) / (height - 1), water = cover || plan.cover;
      const padded = band ? width + 2 * band.margin : 0;
      removeSpecks(heights, width, height, waterLevel, 1 / scale, k => {
        const i = k % width, j = (k - i) / width;
        return (water !== null && water[Math.round(j * csy) * gw + Math.round(i * csx)] === LC_WATER) ||
          (band !== null && band.edge[(j + band.margin) * padded + i + band.margin] < 0);
      });
      band = null;
    }

    const {lo, hi, capped} = clampAndMeasure(heights, normalized && normalized.rivers && normalized.rivers.deepest > 0 ? Math.min(floor, riverFloor) : floor, ceiling);
    const levels = range(lo, hi);
    const black = levels.min, white = levels.max;
    const maxValue = 2 ** bitDepth - 1;
    const samples = new Uint16Array(heights.length);
    for (let i = 0; i < heights.length; i++) {
      const v = Math.round((heights[i] - black) / (white - black) * maxValue);
      samples[i] = Math.min(maxValue, Math.max(0, v));
    }

    const meta = Object.assign({
      centerLat: yToLat((region.y0 + region.y1) / 2), centerLng: xToLng((region.x0 + region.x1) / 2),
      width: northLeft ? height : width, height: northLeft ? width : height, northEdge: northLeft ? 'left' : 'top',
      bitDepth: bitDepth, metersPerPixel: groundWidth(region) / (width - 1),
      blackMeters: black, whiteMeters: white,
      floorMeters: floor,
      ceilingMeters: ceiling,
      cappedFraction: capped / heights.length,
      bathymetry: bathymetry,
      waterNormalization: normalized,
      polders: polders,
      lowLand: lowLand,
      canopy: canopy,
      relief: relief ? {gain: reliefOptions(relief, 1).gain, mountain: reliefOptions(relief, 1).mountain} : null,
      dataMinMeters: lo, dataMaxMeters: hi,
      sourceZoom: zoom,
      upsampled: (region.x1 - region.x0) * TILE_SIZE * 2 ** zoom < width - 1
    }, bounds, options.meta);

    onStage('Writing PNG...', 0);
    const blob = await encodeTurned(samples, width, height, bitDepth, {Description: JSON.stringify(meta)}, northLeft, f => onStage('Writing PNG...', f));
    return {blob: blob, meta: meta, terrain: heights};
  }

  return {
    // Normalized Web Mercator: x and y run 0 to 1 from the west and north edges of the world.
    project: function (lat, lng) {
      return {x: lngToX(lng), y: latToY(lat)};
    },
    unproject: function (x, y) {
      return {lat: yToLat(y), lng: xToLng(x)};
    },
    groundWidth: function (bounds) {
      return groundWidth(boundsToRegion(bounds));
    },
    // Ground meters from the north edge to the south edge, along a meridian. Web Mercator stretches it. The meters per pixel can't give it.
    groundHeight: function (bounds) {
      return (bounds.north - bounds.south) / 360 * EARTH_CIRCUMFERENCE;
    },
    analyze: analyze,
    render: render,
    renderBiomes: renderBiomes,
    terrainPatch: terrainPatch,
    polders: async function (bounds, width, height, waterline, scale, onStage, everywhere) {
      const {width: gw, height: gh} = rasterSize(width, height);
      const region = boundsToRegion(bounds);
      return polderPlan(await landCoverFor(region, width, height, onStage), gw, gh, waterline, scale, groundWidth(region) / (width - 1), groundWidth(region) / (gw - 1), everywhere);
    },
    // cover: optional, land cover as landCover gives it for this output. canopy: optional, as the canopy function below gives it.
    planWater: function (bounds, width, height, scale, level, onStage, rivers, riverSlack, maxLift, cover, canopy) {
      return planWaterFor(boundsToRegion(bounds), width, height, null, scale, level, onStage, rivers, riverSlack, cover || null, maxLift, canopy || null);
    },
    // How render lowers forest, for planWater and terrainPatch on fetched heights, or null where there is no dry land.
    // level: real meters, as render's waterLevel. cover: optional, as for planWater.
    canopy: async function (bounds, width, height, level, scale, onStage, cover) {
      const region = boundsToRegion(bounds), {width: gw, height: gh} = rasterSize(width, height), pixelMeters = groundWidth(region) / (width - 1);
      onStage('Fetching elevation tiles...', 0);
      const ground = await sampleRegion(region, gw, gh, pickZoom(region.x1 - region.x0, gw, 1), f => onStage('Fetching elevation tiles...', f));
      cover = cover || await landCoverFor(region, width, height, onStage);
      return canopyPlan(ground, cover, gw, gh, level, 1 / scale, pixelMeters * (width - 1) / (gw - 1), pixelMeters);
    },
    // Land cover classes on the water plan's grid for an output, which render, planWater and measureRivers take to skip fetching it again.
    landCover: function (bounds, width, height, onStage) {
      return landCoverFor(boundsToRegion(bounds), width, height, onStage || function () {});
    },
    measureRivers: measureRivers,
    zip: makeZip,
    yieldToPage: yieldToPage
  };
}());

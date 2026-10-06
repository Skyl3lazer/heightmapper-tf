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
  // A tile with a larger share of bad pixels is noise throughout, so all of it comes from the parent tile.
  const BAD_TILE_SHARE = 0.01;
  const PREVIEW_SIZE = 1024;
  const FLAT_TOLERANCE = 0.02;
  const MIN_WATER_CELLS = 25;
  const WATER_MERGE_METERS = 0.5;
  const BATHYMETRY_URL = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage';
  const LANDCOVER_URL = 'https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/exportImage';
  // Depth and land cover vary slowly next to the game's biome blending, so they're fetched at most this many pixels across.
  const RASTER_MAX_SIZE = 2049;
  // Bytes handed to the PNG compressor at a time, which sets how often its progress is reported.
  const PNG_CHUNK = 1 << 20;
  // Impact Observatory land cover classes.
  const LC_NO_DATA = 0, LC_WATER = 1, LC_TREES = 2, LC_FLOODED = 4, LC_BARE = 8, LC_SNOW = 9, LC_CLOUDS = 10;
  // Water normalization. Smaller water bodies would pin the land around them to the water level.
  const NORMALIZE_MIN_KM2 = 0.5;
  // In-game meters. Higher water bodies would need a crater around them, so they stay dry.
  const NORMALIZE_MAX_LIFT = 100;
  // The steepest slope normalization adds to land in game, and the slope of the beds it lays below the shore.
  const NORMALIZE_GRADE = 0.1;
  // In-game meters. Rivers lowered by different amounts meet in a seam, which a blur this wide turns into a slope.
  const NORMALIZE_SEAM = 200;
  // Real meters a lowered surface may still sit above the level and count as water, for survey steps along a river.
  const NORMALIZE_SURFACE_TOLERANCE = 2;
  // Real meters mapped water that needs no lowering may sit above the level and still be filled. Tidal channels often survey this high.
  const LEVEL_WATER_TOLERANCE = 3;
  // Real meters above such a channel's own surface that still count as its water, which keeps its banks dry.
  const CHANNEL_SURFACE_TOLERANCE = 0.5;
  // In-game meters. OpenStreetMap rivers too narrow for land cover are cut as channels this wide.
  const RIVER_LINE_WIDTH = 16;
  // Real meters a river line may still sit above the level after lowering and be cut. A line drawn up a valley wall would cut a gash.
  const RIVER_LINE_TOLERANCE = 5;
  // In-game meters.
  const BED_MAX_DEPTH = 10;
  // Rows of a full-size grid between progress reports, each a moment the page can repaint.
  const ROW_BATCH = 256;
  // Transport Fever 3 writes biomes 0 to 4 as these gray levels.
  const BIOME_GRAY = [0, 63, 127, 191, 255];
  const GAME_METERS_PER_PIXEL = 4;
  // Real-world slopes in degrees. The game's horizontal squeeze would make gentle land read as hills.
  const HILL_SLOPE = 10, MOUNTAIN_BIOME_SLOPE = 25, MOUNTAIN_MASK_SLOPE = 20;
  // In-game meters.
  const RIVER_MAX_WIDTH = 280;
  // Real meters. Coast hills are land near the sea where this share of the land within HILL_AREA_RADIUS is steeper than HILL_SLOPE.
  const COAST_HILLS_DISTANCE = 15000, HILL_AREA_RADIUS = 500, HILL_AREA_SHARE = 0.3;
  // Real meters. The game's volcano covers the whole cone, so each OpenStreetMap volcano spreads down the hill slopes around it.
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

  // Fills bad pixels from the parent tile one zoom level coarser, which repairs itself the same way.
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
  // The step is measured against the slope on both sides, median-smoothed along the edge so features crossing it don't count, then feathered out.
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

  // One row of tiles stitched into a strip TILE_SIZE rows tall.
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
  // The tent spans one output pixel each way and at least one source pixel, which makes it bilinear when upsampling.
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
  // Samples sit on a grid whose first and last pixels are on the region edges, streamed one tile row at a time.
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

    // Heals the edge between strip ty and the one below it, before any row near that edge is read.
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

  // Stored, uncompressed ZIP. The PNGs inside are already compressed, so deflating again would gain little.
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

  // Hydro-flattened lakes and seas are stored as large, perfectly level areas.
  // floor, ceiling: the clamp levels, whose cells are flat only because they were clamped. cover: land cover classes, or null.
  function findWaterSurfaces(heights, width, height, cellArea, floor, ceiling, cover) {
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
      let head = 0, tail = 0, sum = 0, top = -Infinity;
      queue[tail++] = start;
      while (head < tail) {
        const i = queue[head++];
        sum += heights[i];
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
        surfaces.push({level: sum / tail, top: top, cells: tail});
        for (let q = 0; q < tail; q++) claimed[queue[q]] = 1;
      }
    }

    // Land cover has no data over open ocean, so there it falls back to height. It keeps dry land below sea level from counting as water.
    const isWater = i => cover && cover[i] !== LC_NO_DATA && cover[i] !== LC_CLOUDS ? cover[i] === LC_WATER : heights[i] <= 0;

    // Open sea has real depth, so it never shows up as a flat surface. Other water at or below sea level counts as sea.
    let seaCells = 0;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] <= 0 && !claimed[i] && isWater(i)) seaCells++;
    }
    if (seaCells >= MIN_WATER_CELLS) surfaces.push({level: 0, top: 0, cells: seaCells});

    surfaces.sort((a, b) => a.level - b.level);
    const merged = [];
    for (const surface of surfaces) {
      const last = merged[merged.length - 1];
      if (last && surface.level - last.base < WATER_MERGE_METERS) {
        last.top = Math.max(last.top, surface.top);
        last.cells += surface.cells;
      } else {
        merged.push({base: surface.level, top: surface.top, cells: surface.cells});
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
        .map(m => ({level: m.base, top: m.top, areaKm2: m.cells * cellArea / 1e6}))
        .sort((a, b) => b.areaKm2 - a.areaKm2),
      floodShare: floodShare
    };
  }

  // ArcGIS image services return raw pixels on exactly our grid when asked for band-sequential Web Mercator output.
  // ArcGIS image services return no data past the antimeridian, so a box crossing it is fetched in pieces, each shifted back into the world.
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

  // Everything at or below level (meters) is under water in game, so it takes NOAA's depth, never rising above the level.
  // NOAA has no data within a few kilometers of the antimeridian, so those pixels take the nearest depth in their row.
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

  // Cells at or below submerge.level take NOAA depths, and every one ends at or below submerge.top so it sits under the water.
  // onProgress(fraction): as for fetchImageServer.
  // lowered: optional, cells water normalization lowered. Their NOAA values describe the old height, so they are left for layBeds.
  async function applyBathymetry(heights, width, height, region, submerge, onProgress, lowered) {
    const {level, top} = submerge;
    if (!heights.some(h => h <= level)) return 'no water below the water level';
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
    return note;
  }

  // Half-width r and edge share of three box passes that together blur with a standard deviation of sigma pixels.
  // The share weights the cell just past each end of the box, so the blur grows smoothly instead of a whole pixel at a time.
  function boxKernel(sigma) {
    const r = Math.floor((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2);
    const v = sigma * sigma / 3, a = r * (r + 1) * (2 * r + 1) / 3, b = 2 * r + 1;
    return {r: r, share: (v * b - a) / (2 * (r + 1) * (r + 1) - 2 * v)};
  }

  // A Gaussian-like blur of the land, sigma in pixels, from three box passes over normalized sums.
  // Water at or below level is left out entirely, so no shoreline moves.
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

  // Biome map plus the climate's layer masks for Transport Fever 3's biome import, from land cover and terrain steepness.
  // waterLevel: meters, anything at or below it is water. volcanoes: OpenStreetMap volcano nodes, {lat, lon}.
  // width and height are the region's, north up. northLeft turns every image a quarter left.
  async function renderBiomes(options) {
    const {bounds, width, height, climate, waterLevel, volcanoes, northLeft} = options;
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
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const dx = (heights[y * gw + Math.min(x + 1, gw - 1)] - heights[y * gw + Math.max(x - 1, 0)]) / 2;
        const dy = (heights[Math.min(y + 1, gh - 1) * gw + x] - heights[Math.max(y - 1, 0) * gw + x]) / 2;
        slope[i] = Math.atan(Math.hypot(dx, dy) / realSpacing) * 180 / Math.PI;
        const lc = cover[i];
        water[i] = lc === LC_WATER || heights[i] <= waterLevel ? 1 : 0;
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
    async function encode(grid, gray, onProgress) {
      const samples = new Uint8Array(width * height);
      for (let j = 0; j < height; j++) {
        const row = rows[j] * gw;
        for (let i = 0; i < width; i++) samples[j * width + i] = gray[grid[row + columns[i]]];
      }
      return encodeTurned(samples, width, height, 8, {}, northLeft, onProgress);
    }
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
    return {
      biomes: await encode(biome, BIOME_GRAY, writing(keys.length)),
      biomeShares: [0, 1, 2, 3, 4].map(b => share(biome, b)),
      layers: layers
    };
  }

  // Mean over the square of half-width r cells around each cell, from a summed-area table.
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

  // Land around each volcano's summit, grown downhill over slopes steeper than HILL_SLOPE up to VOLCANO_RADIUS.
  // Only going downhill keeps the cone from spreading onto neighboring mountains.
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
      // OpenStreetMap longitudes stay within -180 to 180, so they move to the copy of the world the box is in.
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

  // Mesas and monument valley buttes: cliff-ringed land standing above its surroundings.
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

  // A quarter turn counterclockwise, which puts north on the left.
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

  // Land masses that don't reach the edge of the map are islands.
  function landNotTouchingEdge(water, width, height) {
    const {labels, count} = label(water.map(w => 1 - w), width, height);
    const edge = new Uint8Array(count + 1);
    for (let x = 0; x < width; x++) edge[labels[x]] = edge[labels[(height - 1) * width + x]] = 1;
    for (let y = 0; y < height; y++) edge[labels[y * width]] = edge[labels[y * width + width - 1]] = 1;
    return labels.map(l => l && !edge[l] ? 1 : 0);
  }

  // Heights in meters for the output pixels within radius of (px, py), north up, a square 2 radius + 1 wide.
  // terrain: the heights render returned for this output, read instead of fetching. smoothing and level: as for render.
  // plan: a water normalization plan for fetched patches, which render has already applied to terrain.
  async function terrainPatch(bounds, width, height, px, py, radius, options) {
    const {terrain, smoothing, level, plan} = options;
    const size = 2 * radius + 1;
    if (terrain) {
      const heights = new Float32Array(size * size);
      for (let j = 0; j < size; j++) {
        const y = Math.min(height - 1, Math.max(0, py - radius + j));
        for (let i = 0; i < size; i++) heights[j * size + i] = terrain[y * width + Math.min(width - 1, Math.max(0, px - radius + i))];
      }
      return heights;
    }
    // The blur reaches this far, so a margin this wide makes the smoothed patch match the smoothed map.
    const pad = smoothing > 0 ? 3 * (boxKernel(smoothing).r + 1) : 0;
    const full = size + 2 * pad, reach = radius + pad;
    const region = boundsToRegion(bounds);
    const dx = (region.x1 - region.x0) / (width - 1), dy = (region.y1 - region.y0) / (height - 1);
    const patch = {x0: region.x0 + (px - reach) * dx, x1: region.x0 + (px + reach) * dx, y0: region.y0 + (py - reach) * dy, y1: region.y0 + (py + reach) * dy};
    // Sampled exactly as render samples the map, so this is the terrain in the heightmap.
    const heights = await sampleRegion(patch, full, full, pickZoom(region.x1 - region.x0, width, 2), function () {});
    if (plan) await applyWaterPlan(plan, heights, full, full, px - reach, py - reach, width, height);
    if (!pad) return heights;
    await smoothLand(heights, full, full, smoothing, level);
    const out = new Float32Array(size * size);
    for (let j = 0; j < size; j++) out.set(heights.subarray((j + pad) * full + pad, (j + pad) * full + pad + size), j * size);
    return out;
  }

  // Plans water normalization on a gw x gh grid: how far to lower each cell so rivers and lakes above the water level reach it.
  // heights and cover: real meters and land cover classes on the grid. cellMeters and gameCell: real and in-game meters per cell.
  // level: real meters the water should end at. Returns null when there is no water to work from.
  // rivers: optional, river courses on the grid. Land cover misses rivers narrower than its 10 m cells can see.
  async function planWater(heights, cover, gw, gh, cellMeters, gameCell, scale, level, rivers) {
    const n = gw * gh;
    const water = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (cover[i] === LC_WATER || (rivers && rivers[i])) water[i] = 1;
    // Trees and bridges break rivers into pieces, so pieces two cells apart count as one water body.
    const {labels, count} = label(distanceTo(water, gw, gh).map(d => d <= 2 ? 1 : 0), gw, gh);
    const cells = new Float64Array(count + 1);
    for (let i = 0; i < n; i++) if (water[i]) cells[labels[i]]++;
    const minCells = NORMALIZE_MIN_KM2 * 1e6 / (cellMeters * cellMeters);
    // The lowest water neighbor keeps bank cells out of the surface, then a blur along the water evens out survey steps.
    // A river course only marks where the river runs, so its surface is the lowest ground right around it.
    const sum = new Float32Array(n), weight = new Float32Array(n);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (!water[i] || cells[labels[i]] < minCells) continue;
        let low = heights[i];
        for (let v = Math.max(0, y - 1); v <= Math.min(gh - 1, y + 1); v++) {
          for (let u = Math.max(0, x - 1); u <= Math.min(gw - 1, x + 1); u++) {
            if (water[v * gw + u] || (rivers && rivers[i])) low = Math.min(low, heights[v * gw + u]);
          }
        }
        sum[i] = low;
        weight[i] = 1;
      }
    }
    const kept = weight.slice();
    const {r, share} = boxKernel(3);
    for (let pass = 0; pass < 3; pass++) {
      boxSum(sum, gw, gh, r, share);
      boxSum(weight, gw, gh, r, share);
    }
    const surface = new Float32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (!kept[i]) continue;
      surface[i] = sum[i] / weight[i];
      any = true;
    }
    if (!any) return null;

    const guard = 1 / scale, maxLift = NORMALIZE_MAX_LIFT / scale;
    const lift = new Float32Array(n), lowered = new Uint8Array(n), atLevel = new Uint8Array(n);
    // The limit goes cell by cell, so a river climbing into hills still fills its lower reaches. A lake is flat, so it fills or stays dry whole.
    const bodies = new Uint8Array(count + 1);
    let deepest = 0, dryCells = 0;
    for (let i = 0; i < n; i++) {
      if (!kept[i]) continue;
      if (surface[i] - level > maxLift) {
        kept[i] = 0;
        dryCells++;
        continue;
      }
      lift[i] = Math.max(0, surface[i] - level);
      if (lift[i] > guard) lowered[i] = 1;
      else atLevel[i] = 1;
      bodies[labels[i]] |= lowered[i] ? 2 : 1;
      deepest = Math.max(deepest, lift[i] * scale);
    }
    // River lines are drawn at full resolution with their own width, so they stay out of the coarse shoreline rules below.
    const lineClass = new Uint8Array(n);
    if (rivers) {
      for (let i = 0; i < n; i++) {
        if (!rivers[i] || cover[i] === LC_WATER) continue;
        lineClass[i] = lowered[i] ? 2 : atLevel[i] ? 1 : 0;
        lowered[i] = atLevel[i] = 0;
      }
    }
    const stats = {lowered: bodies.filter(b => b & 2).length, dryKm2: dryCells * cellMeters * cellMeters / 1e6, deepest: deepest};
    // Water at the level that surveys a little above it, like a tidal channel, has its own flat surface, which draws its shoreline.
    // The middle of its neighbors skips bank samples. Water at or below the level stays out of it.
    const channelSum = new Float32Array(n), channelWeight = new Float32Array(n), near = [];
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
    const offset = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!(lift[i] > 0)) continue;
      // The fade lengthens with the lift, so the slope it adds to the land stays under NORMALIZE_GRADE in game.
      const t = Math.max(0, 1 - distance[i] * gameCell * NORMALIZE_GRADE / (lift[i] * scale));
      offset[i] = lift[i] * t * t * (3 - 2 * t);
    }
    // Seams sit away from the water, so the blur fades out toward the water, which keeps its full lowering.
    const exact = offset.slice();
    await smoothLand(offset, gw, gh, NORMALIZE_SEAM / gameCell, -Infinity);
    for (let i = 0; i < n; i++) {
      const w = Math.max(0, 1 - distance[i] * gameCell / (2 * NORMALIZE_SEAM));
      offset[i] = exact[i] * w + offset[i] * (1 - w);
    }
    return {offset: offset, lowered: lowered, channel: channel, lineClass: lineClass, level: level, guard: guard, gw: gw, gh: gh, stats: stats};
  }

  // Fetches land cover and plans water normalization for an output. heights: real meters for the whole output, or null to fetch coarser ones.
  // onStage(stage, fraction): reports the downloads. rivers: optional, river courses as [[lat, lon], ...] lines.
  async function planWaterFor(region, width, height, heights, scale, level, onStage, rivers) {
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
    }
    onStage('Fetching land cover...');
    const cover = await fetchImageServer(LANDCOVER_URL, region, gw, gh, 'U8', 'RSP_NearestNeighbor', f => onStage('Fetching land cover...', f));
    const lines = rivers ? riverPixels(rivers, region, width, height) : null;
    const plan = await planWater(coarse, cover, gw, gh, groundWidth(region) / (gw - 1), GAME_METERS_PER_PIXEL * (width - 1) / (gw - 1), scale, level,
      lines ? drawLines(lines, (gw - 1) / (width - 1), (gh - 1) / (height - 1), 0, 0, gw, gh, 0) : null);
    if (plan) plan.lines = lines;
    return plan;
  }

  // River courses, [[lat, lon], ...] lines, as [x0, y0, x1, y1, ...] in output pixels.
  function riverPixels(rivers, region, width, height) {
    const centerLng = xToLng((region.x0 + region.x1) / 2);
    return rivers.map(line => {
      const out = new Float64Array(line.length * 2);
      line.forEach(([lat, lng], p) => {
        // OpenStreetMap longitudes stay within -180 to 180, so they move to the copy of the world the region is in.
        out[2 * p] = (lngToX(lng + 360 * Math.round((centerLng - lng) / 360)) - region.x0) / (region.x1 - region.x0) * (width - 1);
        out[2 * p + 1] = (latToY(lat) - region.y0) / (region.y1 - region.y0) * (height - 1);
      });
      return out;
    });
  }

  // Marks the cells of a width x height grid within radius of the lines, scaled by sx and sy, with the grid starting at output pixel (x0, y0).
  function drawLines(lines, sx, sy, x0, y0, width, height, radius) {
    const cells = new Uint8Array(width * height), brush = [];
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) if (dx * dx + dy * dy <= radius * radius) brush.push([dx, dy]);
    }
    for (const line of lines) {
      for (let p = 2; p < line.length; p += 2) {
        const ax = line[p - 2] * sx - x0, ay = line[p - 1] * sy - y0, bx = line[p] * sx - x0, by = line[p + 1] * sy - y0;
        if (Math.max(ax, bx) < -radius - 1 || Math.min(ax, bx) > width + radius || Math.max(ay, by) < -radius - 1 || Math.min(ay, by) > height + radius) continue;
        const steps = Math.ceil(2 * Math.max(Math.abs(bx - ax), Math.abs(by - ay))) + 1;
        for (let s = 0; s <= steps; s++) {
          const cx = Math.round(ax + (bx - ax) * s / steps), cy = Math.round(ay + (by - ay) * s / steps);
          for (const [dx, dy] of brush) {
            const x = cx + dx, y = cy + dy;
            if (x >= 0 && y >= 0 && x < width && y < height) cells[y * width + x] = 1;
          }
        }
      }
    }
    return cells;
  }

  // Lowers a grid by a plan and sets the water it lowered to the plan's level. Returns which cells that water covers.
  // The grid covers output pixels x0 to x0 + width - 1 and y0 to y0 + height - 1 of an output outputWidth x outputHeight.
  // onProgress(fraction): optional, called every ROW_BATCH rows, and awaited.
  async function applyWaterPlan(plan, heights, width, height, x0, y0, outputWidth, outputHeight, onProgress) {
    const {offset, lowered, channel, lineClass, level, guard, gw, gh} = plan;
    const sx = (gw - 1) / (outputWidth - 1), sy = (gh - 1) / (outputHeight - 1);
    const lifted = new Uint8Array(width * height);
    const river = plan.lines ? drawLines(plan.lines, 1, 1, x0, y0, width, height, RIVER_LINE_WIDTH / GAME_METERS_PER_PIXEL / 2) : null;
    for (let j = 0; j < height; j++) {
      const v = Math.min(gh - 1, Math.max(0, (y0 + j) * sy)), r = Math.min(Math.floor(v), gh - 2), fy = v - r;
      for (let i = 0; i < width; i++) {
        const u = Math.min(gw - 1, Math.max(0, (x0 + i) * sx)), c = Math.min(Math.floor(u), gw - 2), fx = u - c, a = r * gw + c;
        const k = j * width + i, before = heights[k];
        heights[k] -= (offset[a] * (1 - fx) + offset[a + 1] * fx) * (1 - fy) + (offset[a + gw] * (1 - fx) + offset[a + gw + 1] * fx) * fy;
        const line = river && river[k] ? lineClass[Math.round(v) * gw + Math.round(u)] : 0;
        if (line && heights[k] <= level + RIVER_LINE_TOLERANCE) {
          heights[k] = level;
          if (line === 2) lifted[k] = 1;
        } else if ((lowered[a] || lowered[a + 1] || lowered[a + gw] || lowered[a + gw + 1]) && heights[k] <= level + NORMALIZE_SURFACE_TOLERANCE) {
          // The coarse land cover picks out the water. The full-resolution surface draws its exact shoreline.
          heights[k] = level;
          lifted[k] = 1;
        } else if (heights[k] > level && heights[k] <= level + LEVEL_WATER_TOLERANCE && heights[k] <= channelSurface(channel, a, gw, fx, fy) + CHANNEL_SURFACE_TOLERANCE) {
          // NOAA still gives these their beds.
          heights[k] = level;
        } else if (before > level + guard && heights[k] < level + guard) {
          heights[k] = level + guard;
        }
      }
      if (onProgress && j % ROW_BATCH === ROW_BATCH - 1) await onProgress((j + 1) / height);
    }
    return lifted;
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
  // That is water normalization lowered, and water applyBathymetry left at its flat top. The bed deepens from the shore.
  // submerge: as for applyBathymetry. gameCell: in-game meters per cell. Returns how many cells got a bed.
  // onProgress(fraction): optional, called every ROW_BATCH rows of each pass, and awaited.
  async function layBeds(heights, width, height, submerge, lowered, gameCell, scale, onProgress) {
    const {level, top} = submerge, flat = Math.fround(top);
    // Chamfer distance to the shore in thirds of a cell, which reaches past the deepest bed.
    const d = new Uint8Array(heights.length);
    for (let i = 0; i < d.length; i++) d[i] = heights[i] <= level ? 255 : 0;
    let beds = 0;
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
        if ((lowered && lowered[i]) || heights[i] === flat) {
          heights[i] = Math.min(heights[i], top - Math.min(BED_MAX_DEPTH, NORMALIZE_GRADE * gameCell * v / 3) / scale);
          beds++;
        }
      }
      if (onProgress && y % ROW_BATCH === 0) await onProgress((2 * height - y) / (2 * height));
    }
    return beds;
  }

  // Coarse pass for live feedback: extremes and water surfaces, without fetching full-resolution tiles.
  // limits(peak): given the highest point in meters, the {floor, ceiling} in meters that heights are clamped into.
  // submerge(water, floodShare, areaKm2): given the water surfaces found, the {level, top} in meters for applyBathymetry, or null.
  // smoothing: as for render, in pixels of an image outputWidth wide.
  // normalizeWater(water, floodShare, areaKm2): given the water surfaces found, the real height rivers and lakes above it are lowered to, or null.
  async function analyze(options) {
    const {bounds, aspect, limits, submerge, smoothing, outputWidth, normalizeWater} = options;
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
    const cellSize = groundWidth(region) / (width - 1), gameCell = GAME_METERS_PER_PIXEL * (outputWidth - 1) / (width - 1);
    let extremes = clampAndMeasure(heights, floor, ceiling);
    const {surfaces: water, floodShare} = findWaterSurfaces(heights, width, height, cellSize * cellSize, floor, ceiling, cover);
    const areaKm2 = width * height * cellSize * cellSize / 1e6;
    const sea = submerge ? submerge(water, floodShare, areaKm2) : null;
    // The level comes from the map as it is, so lowering water onto it can't change which level that is.
    const surface = normalizeWater && cover ? normalizeWater(water, floodShare, areaKm2) : null;
    let plan = null, lifted = null;
    if (surface !== null && isFinite(surface)) {
      plan = await planWater(heights, cover, width, height, cellSize, gameCell, scale, surface);
      if (plan) lifted = await applyWaterPlan(plan, heights, width, height, 0, 0, width, height);
    }
    let bathymetry = null;
    if (sea) {
      bathymetry = await applyBathymetry(heights, width, height, region, sea, null, lifted);
      await layBeds(heights, width, height, sea, lifted, gameCell, scale);
    }
    if (smoothing) await smoothLand(heights, width, height, smoothing * (width - 1) / (outputWidth - 1), sea ? sea.level : -Infinity);
    if (sea || smoothing || lifted) extremes = clampAndMeasure(heights, floor, ceiling);
    return {
      min: extremes.lo, max: extremes.hi, peak: peak, groundWidth: groundWidth(region), areaKm2: areaKm2,
      water: water, floodShare: floodShare, bathymetry: bathymetry, normalized: plan ? plan.stats : null,
      landCover: landCover, centerLat: yToLat((region.y0 + region.y1) / 2)
    };
  }

  // limits(peak): as for analyze. range(lo, hi): given the clamped data's extremes in meters, returns the {min, max} that map to black and white.
  // submerge: the {level, top} in meters for applyBathymetry, or null. smoothing: the blur's sigma in pixels, or 0.
  // waterLevel: meters, anything at or below it stays out of the smoothing.
  // normalizeWater: lower rivers and lakes onto the water surface limits gives, in real meters as waterSurface.
  // rivers: optional, river courses as [[lat, lon], ...] lines for normalization.
  // width and height are the region's, north up. northLeft turns the image a quarter left.
  async function render(options) {
    const {bounds, width, height, bitDepth, range, limits, submerge, smoothing, waterLevel, northLeft, normalizeWater, rivers} = options;
    const onProgress = options.onProgress || function () {};
    const onStage = options.onStage || function () {};
    const region = boundsToRegion(bounds);
    const zoom = pickZoom(region.x1 - region.x0, width, 2);

    const heights = await sampleRegion(region, width, height, zoom, onProgress);
    // limits sees the peak before normalization and smoothing, the same one the preview measures.
    const peak = highest(heights);
    const {floor, ceiling, scale, waterSurface} = limits(peak);
    let normalized = null, lifted = null;
    if (normalizeWater && isFinite(waterSurface)) {
      try {
        const plan = await planWaterFor(region, width, height, heights, scale, waterSurface, onStage, rivers);
        if (plan) {
          onStage('Normalizing water...', 0);
          await yieldToPage();
          lifted = await applyWaterPlan(plan, heights, width, height, 0, 0, width, height, f => {
            onStage('Normalizing water...', f);
            return yieldToPage();
          });
          normalized = plan.stats;
        }
      } catch (e) {
        normalized = 'unavailable (' + e.message + ')';
      }
    }
    let bathymetry = null;
    if (submerge) {
      onStage('Fetching water depths...');
      bathymetry = await applyBathymetry(heights, width, height, region, submerge, f => onStage('Fetching water depths...', f), lifted);
      onStage('Laying water beds...', 0);
      await yieldToPage();
      const beds = await layBeds(heights, width, height, submerge, lifted, GAME_METERS_PER_PIXEL, scale, f => {
        onStage('Laying water beds...', f);
        return yieldToPage();
      });
      if (beds) bathymetry += ', beds estimated under ' + (beds * (groundWidth(region) / (width - 1)) ** 2 / 1e6).toFixed(1) + ' km2 of water without depth data';
    }
    if (smoothing) {
      onStage('Smoothing terrain...', 0);
      await yieldToPage();
      await smoothLand(heights, width, height, smoothing, waterLevel, f => {
        onStage('Smoothing terrain...', f);
        return yieldToPage();
      });
    }

    const {lo, hi, capped} = clampAndMeasure(heights, floor, ceiling);
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
    analyze: analyze,
    render: render,
    renderBiomes: renderBiomes,
    terrainPatch: terrainPatch,
    planWater: function (bounds, width, height, scale, level, onStage, rivers) {
      return planWaterFor(boundsToRegion(bounds), width, height, null, scale, level, onStage, rivers);
    },
    zip: makeZip,
    yieldToPage: yieldToPage
  };
}());

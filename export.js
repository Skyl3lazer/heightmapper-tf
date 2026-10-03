/*jslint browser: true*/

// Builds a heightmap straight from terrarium elevation tiles, bypassing the WebGL canvas.
var heightmapExport = (function () {
  'use strict';

  const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const TILE_SIZE = 256;
  const MAX_ZOOM = 15;
  const EARTH_CIRCUMFERENCE = 40075016.686;
  const FETCH_ATTEMPTS = 4;
  const PREVIEW_SIZE = 1024;
  const FLAT_TOLERANCE = 0.02;
  const MIN_WATER_CELLS = 25;
  const WATER_MERGE_METERS = 0.5;
  const BATHYMETRY_URL = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage';
  const LANDCOVER_URL = 'https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/exportImage';
  // Depth and land cover vary slowly next to the game's biome blending, so they're fetched at most this many pixels across.
  const RASTER_MAX_SIZE = 2049;
  // Impact Observatory land cover classes.
  const LC_NO_DATA = 0, LC_WATER = 1, LC_TREES = 2, LC_FLOODED = 4, LC_BARE = 8, LC_SNOW = 9, LC_CLOUDS = 10;
  // Transport Fever 3 writes biomes 0 to 4 as these gray levels.
  const BIOME_GRAY = [0, 63, 127, 191, 255];
  const GAME_METERS_PER_PIXEL = 4;
  // Real-world slopes in degrees. The game's horizontal squeeze would make gentle land read as hills.
  const HILL_SLOPE = 10, MOUNTAIN_BIOME_SLOPE = 25, MOUNTAIN_MASK_SLOPE = 20;
  // In-game meters.
  const RIVER_MAX_WIDTH = 280;
  // The masks each climate's biome import reads that can be derived from terrain and land cover.
  // Dry's coast_hills, mesas and monument_valley and Tropical's volcano are landforms these sources can't identify.
  const CLIMATE_LAYERS = {
    Temperate: ['mountains', 'rivers'],
    Dry: ['mountains', 'rivers'],
    Tropical: ['islands', 'mountains'],
    Subarctic: ['lakes', 'mountains', 'swamps']
  };
  const SEAM_FEATHER = 32;
  const SEAM_MEDIAN_RADIUS = 7;
  const SEAM_MIN_STEP = 0.1;

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

  async function fetchTile(z, x, y) {
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
      if (Math.abs(offset) < SEAM_MIN_STEP) continue;
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
    for (let tx = tx0; tx <= tx1; tx++) tiles.push(fetchTile(z, tx, ty));
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
  function footprints(start, end, count, scale) {
    const radius = Math.max((end - start) * scale / (count - 1), 1);
    const offsets = new Int32Array(count + 1);
    const index = [], weight = [];
    for (let i = 0; i < count; i++) {
      const center = (start + i / (count - 1) * (end - start)) * scale;
      const first = Math.max(0, Math.ceil(center - radius - 0.5));
      const last = Math.min(scale - 1, Math.floor(center + radius - 0.5));
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
    const cols = footprints(region.x0, region.x1, width, scale);
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
  async function makeZip(files) {
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const file of files) {
      const name = new TextEncoder().encode(file.path);
      const size = file.blob.size;
      const crc = crc32(new Uint8Array(await file.blob.arrayBuffer()));

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

  async function encodeGrayPng(samples, width, height, bitDepth, text) {
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

    const compressed = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
    const idat = new Uint8Array(await new Response(compressed).arrayBuffer());

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
  async function fetchImageServer(url, region, width, height, pixelType, interpolation) {
    const span = 2 * Math.PI * 6378137;
    const dx = (region.x1 - region.x0) * span / (width - 1), dy = (region.y1 - region.y0) * span / (height - 1);
    const west = (region.x0 - 0.5) * span - dx / 2, east = (region.x1 - 0.5) * span + dx / 2;
    const south = (0.5 - region.y1) * span - dy / 2, north = (0.5 - region.y0) * span + dy / 2;
    const params = new URLSearchParams({
      bbox: [west, south, east, north].join(','), bboxSR: 3857, imageSR: 3857, size: width + ',' + height,
      format: 'bsq', pixelType: pixelType, interpolation: interpolation, f: 'image'
    });
    const response = await fetch(url + '?' + params, {signal: AbortSignal.timeout(120000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const floats = pixelType === 'F32';
    if (buffer.byteLength < width * height * (floats ? 4 : 1)) throw new Error('short response');
    return floats ? new Float32Array(buffer, 0, width * height) : new Uint8Array(buffer, 0, width * height);
  }

  function rasterSize(width, height) {
    const scale = Math.min(1, (RASTER_MAX_SIZE - 1) / (Math.max(width, height) - 1));
    return {width: Math.max(2, Math.round((width - 1) * scale) + 1), height: Math.max(2, Math.round((height - 1) * scale) + 1)};
  }

  // Everything at or below level (meters) is under water in game, so it takes NOAA's depth, never rising above the level.
  async function applyBathymetry(heights, width, height, region, level) {
    if (!heights.some(h => h <= level)) return 'no water below the water level';
    const {width: bw, height: bh} = rasterSize(width, height);
    let depth;
    try {
      depth = await fetchImageServer(BATHYMETRY_URL, region, bw, bh, 'F32', 'RSP_BilinearInterpolation');
    } catch (e) {
      return 'NOAA water depths unavailable (' + e.message + ')';
    }
    const fx = (bw - 1) / (width - 1), fy = (bh - 1) / (height - 1);
    for (let j = 0; j < height; j++) {
      const v = j * fy, r = Math.min(Math.floor(v), bh - 2), ty = v - r;
      for (let i = 0; i < width; i++) {
        const k = j * width + i;
        if (heights[k] > level) continue;
        const u = i * fx, c = Math.min(Math.floor(u), bw - 2), tx = u - c;
        const top = depth[r * bw + c] + (depth[r * bw + c + 1] - depth[r * bw + c]) * tx;
        const bottom = depth[(r + 1) * bw + c] + (depth[(r + 1) * bw + c + 1] - depth[(r + 1) * bw + c]) * tx;
        const d = top + (bottom - top) * ty;
        if (d > -12000 && d < 9000) heights[k] = Math.min(d, level);
      }
    }
    return 'NOAA water depths applied';
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
  function distanceTo(source, width, height) {
    const d = new Float32Array(width * height);
    for (let i = 0; i < d.length; i++) d[i] = source[i] ? 0 : Infinity;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) {
          v = Math.min(v, d[i - width] + 1);
          if (x > 0) v = Math.min(v, d[i - width - 1] + Math.SQRT2);
          if (x < width - 1) v = Math.min(v, d[i - width + 1] + Math.SQRT2);
        }
        d[i] = v;
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const i = y * width + x;
        let v = d[i];
        if (x < width - 1) v = Math.min(v, d[i + 1] + 1);
        if (y < height - 1) {
          v = Math.min(v, d[i + width] + 1);
          if (x < width - 1) v = Math.min(v, d[i + width + 1] + Math.SQRT2);
          if (x > 0) v = Math.min(v, d[i + width - 1] + Math.SQRT2);
        }
        d[i] = v;
      }
    }
    return d;
  }

  // Biome map plus the climate's layer masks for Transport Fever 3's biome import, from land cover and terrain steepness.
  // waterLevel: meters, anything at or below it is water.
  async function renderBiomes(options) {
    const {bounds, width, height, climate, waterLevel} = options;
    const onStage = options.onStage || function () {};
    const region = boundsToRegion(bounds);
    const {width: gw, height: gh} = rasterSize(width, height);

    onStage('Fetching elevation tiles...');
    const heights = await sampleRegion(region, gw, gh, pickZoom(region.x1 - region.x0, gw, 1), function () {});
    onStage('Fetching land cover...');
    const cover = await fetchImageServer(LANDCOVER_URL, region, gw, gh, 'U8', 'RSP_NearestNeighbor');

    const spacing = GAME_METERS_PER_PIXEL * (width - 1) / (gw - 1);
    const realSpacing = groundWidth(region) / (gw - 1);
    const biome = new Uint8Array(gw * gh), mountains = new Uint8Array(gw * gh), water = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const dx = (heights[y * gw + Math.min(x + 1, gw - 1)] - heights[y * gw + Math.max(x - 1, 0)]) / 2;
        const dy = (heights[Math.min(y + 1, gh - 1) * gw + x] - heights[Math.max(y - 1, 0) * gw + x]) / 2;
        const slope = Math.atan(Math.hypot(dx, dy) / realSpacing) * 180 / Math.PI;
        const lc = cover[i];
        water[i] = lc === LC_WATER || heights[i] <= waterLevel ? 1 : 0;
        mountains[i] = slope > MOUNTAIN_MASK_SLOPE ? 1 : 0;
        if (water[i]) biome[i] = 0;
        else if (lc === LC_SNOW || slope > MOUNTAIN_BIOME_SLOPE) biome[i] = 4;
        else if (lc === LC_BARE || slope > HILL_SLOPE) biome[i] = 3;
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
      islands: () => landNotTouchingEdge(water, gw, gh)
    };

    const columns = new Int32Array(width), rows = new Int32Array(height);
    for (let i = 0; i < width; i++) columns[i] = Math.round(i * (gw - 1) / (width - 1));
    for (let j = 0; j < height; j++) rows[j] = Math.round(j * (gh - 1) / (height - 1));
    async function encode(grid, gray) {
      const samples = new Uint8Array(width * height);
      for (let j = 0; j < height; j++) {
        const row = rows[j] * gw;
        for (let i = 0; i < width; i++) samples[j * width + i] = gray[grid[row + columns[i]]];
      }
      return encodeGrayPng(samples, width, height, 8, {});
    }
    onStage('Writing biome maps...');
    const share = (grid, value) => grid.reduce((n, v) => n + (v === value ? 1 : 0), 0) / grid.length;
    const layers = [];
    for (const key of CLIMATE_LAYERS[climate] || CLIMATE_LAYERS.Temperate) {
      const grid = masks[key]();
      layers.push({key: key, blob: await encode(grid, [0, 255]), share: share(grid, 1)});
    }
    return {
      biomes: await encode(biome, BIOME_GRAY),
      biomeShares: [0, 1, 2, 3, 4].map(b => share(biome, b)),
      layers: layers
    };
  }

  // Land masses that don't reach the edge of the map are islands.
  function landNotTouchingEdge(water, width, height) {
    const islands = new Uint8Array(water.length);
    const seen = new Uint8Array(water.length);
    const queue = new Int32Array(water.length);
    for (let start = 0; start < water.length; start++) {
      if (water[start] || seen[start]) continue;
      seen[start] = 1;
      let head = 0, tail = 0, edge = false;
      queue[tail++] = start;
      while (head < tail) {
        const i = queue[head++];
        const x = i % width, y = (i - x) / width;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
        for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
          if (j >= 0 && !water[j] && !seen[j]) {
            seen[j] = 1;
            queue[tail++] = j;
          }
        }
      }
      if (!edge) for (let q = 0; q < tail; q++) islands[queue[q]] = 1;
    }
    return islands;
  }

  // Coarse pass for live feedback: extremes and water surfaces, without fetching full-resolution tiles.
  // bathymetryLevel(water, floodShare, areaKm2): given the water surfaces found, the meters below which NOAA depths apply, or null.
  async function analyze(options) {
    const {bounds, aspect, floor, ceiling, bathymetryLevel} = options;
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
    let extremes = clampAndMeasure(heights, floor, ceiling);
    const cellSize = groundWidth(region) / (width - 1);
    const {surfaces: water, floodShare} = findWaterSurfaces(heights, width, height, cellSize * cellSize, floor, ceiling, cover);
    const areaKm2 = width * height * cellSize * cellSize / 1e6;
    const level = bathymetryLevel ? bathymetryLevel(water, floodShare, areaKm2) : null;
    let bathymetry = null;
    if (level !== null) {
      bathymetry = await applyBathymetry(heights, width, height, region, level);
      extremes = clampAndMeasure(heights, floor, ceiling);
    }
    return {
      min: extremes.lo, max: extremes.hi, groundWidth: groundWidth(region), areaKm2: areaKm2,
      water: water, floodShare: floodShare, bathymetry: bathymetry,
      landCover: landCover, centerLat: yToLat((region.y0 + region.y1) / 2)
    };
  }

  // floor, ceiling: meters, heights are clamped into that span. range(lo, hi): given the data's extremes in meters, returns the {min, max} that map to black and white.
  // bathymetryLevel: meters below which NOAA depths apply, or null.
  async function render(options) {
    const {bounds, width, height, bitDepth, range, floor, ceiling, bathymetryLevel} = options;
    const onProgress = options.onProgress || function () {};
    const onStage = options.onStage || function () {};
    const region = boundsToRegion(bounds);
    const zoom = pickZoom(region.x1 - region.x0, width, 2);

    const heights = await sampleRegion(region, width, height, zoom, onProgress);
    let bathymetry = null;
    if (bathymetryLevel !== null && bathymetryLevel !== undefined) {
      onStage('Fetching water depths...');
      bathymetry = await applyBathymetry(heights, width, height, region, bathymetryLevel);
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
      width: width, height: height, bitDepth: bitDepth, metersPerPixel: groundWidth(region) / (width - 1),
      blackMeters: black, whiteMeters: white,
      floorMeters: floor,
      ceilingMeters: ceiling,
      cappedFraction: capped / heights.length,
      bathymetry: bathymetry,
      dataMinMeters: lo, dataMaxMeters: hi,
      sourceZoom: zoom,
      upsampled: (region.x1 - region.x0) * TILE_SIZE * 2 ** zoom < width - 1
    }, bounds, options.meta);

    const blob = await encodeGrayPng(samples, width, height, bitDepth, {Description: JSON.stringify(meta)});
    return {blob: blob, meta: meta};
  }

  return {
    // Normalized Web Mercator: x and y run 0 to 1 from the west and north edges of the world.
    project: function (lat, lng) {
      return {x: lngToX(lng), y: latToY(lat)};
    },
    groundWidth: function (bounds) {
      return groundWidth(boundsToRegion(bounds));
    },
    analyze: analyze,
    render: render,
    renderBiomes: renderBiomes,
    zip: makeZip
  };
}());

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

  function pngChunk(type, data) {
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    let crc = 0xFFFFFFFF;
    for (let i = 4; i < 8 + data.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xFF] ^ (crc >>> 8);
    view.setUint32(8 + data.length, (crc ^ 0xFFFFFFFF) >>> 0);
    return chunk;
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
  function findWaterSurfaces(heights, width, height, cellArea) {
    const level = (i, j) => Math.abs(heights[i] - heights[j]) < FLAT_TOLERANCE;
    const flat = new Uint8Array(heights.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const flatX = (x > 0 && level(i, i - 1)) || (x < width - 1 && level(i, i + 1));
        const flatY = (y > 0 && level(i, i - width)) || (y < height - 1 && level(i, i + width));
        flat[i] = flatX && flatY ? 1 : 0;
      }
    }

    const surfaces = [];
    const queue = new Int32Array(heights.length);
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
      if (tail >= MIN_WATER_CELLS) surfaces.push({level: sum / tail, top: top, cells: tail});
    }

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
    return merged
      .map(m => ({level: m.base, top: m.top, areaKm2: m.cells * cellArea / 1e6}))
      .sort((a, b) => b.areaKm2 - a.areaKm2);
  }

  // Coarse pass for live feedback: extremes and water surfaces, without fetching full-resolution tiles.
  async function analyze(options) {
    const {bounds, aspect, floor} = options;
    const region = boundsToRegion(bounds);
    const width = Math.max(2, Math.round(PREVIEW_SIZE * Math.min(1, aspect)));
    const height = Math.max(2, Math.round(PREVIEW_SIZE * Math.min(1, 1 / aspect)));
    const heights = await sampleRegion(region, width, height, pickZoom(region.x1 - region.x0, width, 1), function () {});
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] < floor) heights[i] = floor;
      lo = Math.min(lo, heights[i]);
      hi = Math.max(hi, heights[i]);
    }
    const cellSize = groundWidth(region) / (width - 1);
    return {
      min: lo, max: hi, groundWidth: groundWidth(region),
      water: findWaterSurfaces(heights, width, height, cellSize * cellSize)
    };
  }

  // floor: meters, anything lower is raised to it. range(lo, hi): given the data's extremes in meters, returns the {min, max} that map to black and white.
  async function render(options) {
    const {bounds, width, height, bitDepth, range, floor} = options;
    const onProgress = options.onProgress || function () {};
    const region = boundsToRegion(bounds);
    const zoom = pickZoom(region.x1 - region.x0, width, 2);

    const heights = await sampleRegion(region, width, height, zoom, onProgress);

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] < floor) heights[i] = floor;
      lo = Math.min(lo, heights[i]);
      hi = Math.max(hi, heights[i]);
    }
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
      dataMinMeters: lo, dataMaxMeters: hi,
      sourceZoom: zoom,
      upsampled: (region.x1 - region.x0) * TILE_SIZE * 2 ** zoom < width - 1
    }, bounds, options.meta);

    const blob = await encodeGrayPng(samples, width, height, bitDepth, {Description: JSON.stringify(meta)});
    return {blob: blob, meta: meta};
  }

  return {
    groundWidth: function (bounds) {
      return groundWidth(boundsToRegion(bounds));
    },
    analyze: analyze,
    render: render
  };
}());

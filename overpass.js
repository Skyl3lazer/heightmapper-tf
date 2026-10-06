/*jslint browser: true*/

// OpenStreetMap lookups through the Overpass API.
var overpass = (function () {
  'use strict';

  // A keyed service from config.js first, then free public instances with global coverage.
  const URLS = [
    configuredUrl(),
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ].filter(Boolean);
  const TIMEOUT_MS = 90000;
  const HEDGE_MS = 30000;
  // Bigger boxes are looked up in tiles this size, one after another, so no single river query hits the server's limits.
  const RIVER_TILE_DEGREES = 3;

  function configuredUrl() {
    const config = typeof heightmapperConfig === 'undefined' ? {} : heightmapperConfig;
    return (config.overpassUrl || '').replace('{key}', encodeURIComponent(config.overpassKey || ''));
  }

  // Overpass only takes longitudes from -180 to 180, so a box crossing the antimeridian splits into one box each side.
  function bboxes(bounds) {
    const {south, north} = bounds;
    const shift = 360 * Math.round((bounds.west + bounds.east) / 2 / 360);
    const west = bounds.west - shift, east = bounds.east - shift;
    if (east - west >= 360) return [[south, -180, north, 180]];
    if (west < -180) return [[south, west + 360, north, 180], [south, -180, north, east]];
    if (east > 180) return [[south, west, north, 180], [south, -180, north, east - 360]];
    return [[south, west, north, east]];
  }

  // The nodes inside bounds matching an Overpass tag filter such as ["natural"="volcano"].
  function nodes(bounds, filter) {
    const parts = bboxes(bounds).map(b => `node${filter}(${b.join(',')});`).join('');
    return run(`[out:json][timeout:90];(${parts});out qt;`);
  }

  // River courses inside bounds at least minLength real meters long, as [[lat, lon], ...] lines clipped to the box.
  // OpenStreetMap often splits a river into many short pieces, so pieces are first listed with only their name and length, which is small.
  // A named river is judged by the length of all its pieces together, and only the pieces of rivers that pass are fetched with their points.
  async function rivers(bounds, minLength) {
    const rows = Math.ceil((bounds.north - bounds.south) / RIVER_TILE_DEGREES), cols = Math.ceil((bounds.east - bounds.west) / RIVER_TILE_DEGREES);
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        tiles.push(bboxes({
          south: bounds.south + r * (bounds.north - bounds.south) / rows, north: bounds.south + (r + 1) * (bounds.north - bounds.south) / rows,
          west: bounds.west + c * (bounds.east - bounds.west) / cols, east: bounds.west + (c + 1) * (bounds.east - bounds.west) / cols
        }).map(b => b.join(',')));
      }
    }
    const pieces = new Map(), totals = new Map();
    for (const [t, boxes] of tiles.entries()) {
      const ways = boxes.map(box => `way["waterway"="river"](${box});`).join('');
      for (const e of await run(`[out:json][timeout:90];(${ways});convert river ::id=id(),name=t["name"],len=length();out;`)) {
        if (!pieces.has(e.id)) {
          pieces.set(e.id, {name: e.tags.name, length: Number(e.tags.len), tiles: []});
          if (e.tags.name) totals.set(e.tags.name, (totals.get(e.tags.name) || 0) + Number(e.tags.len));
        }
        pieces.get(e.id).tiles.push(t);
      }
    }
    const wanted = tiles.map(() => []);
    for (const [id, piece] of pieces) {
      if ((piece.name ? totals.get(piece.name) : piece.length) >= minLength) piece.tiles.forEach(t => wanted[t].push(id));
    }
    let lines = [];
    for (const [t, boxes] of tiles.entries()) {
      if (!wanted[t].length) continue;
      const ways = boxes.map(box => `way(id:${wanted[t].join(',')})(${box});`).join('');
      // Clipping to the box leaves out the rest of long rivers, which is most of the download on a small map.
      const output = boxes.length === 1 ? `out ids geom(${boxes[0]}) qt;` : 'out ids geom qt;';
      lines = lines.concat((await run(`[out:json][timeout:90];(${ways});${output}`)).flatMap(splitAtGaps));
    }
    return lines;
  }

  // Clipped geometry marks points outside the box as null, and a line must not jump across that gap.
  function splitAtGaps(way) {
    const lines = [];
    let line = [];
    for (const p of way.geometry || []) {
      if (p) {
        line.push([p.lat, p.lon]);
      } else {
        if (line.length > 1) lines.push(line);
        line = [];
      }
    }
    if (line.length > 1) lines.push(line);
    return lines;
  }

  // A down or overloaded instance shouldn't stall the export, so the next one starts after a short wait or a failure.
  function run(data) {
    const body = new URLSearchParams({data: data});
    const done = new AbortController();
    const errors = [];
    let next = 0, running = 0;
    return new Promise((resolve, reject) => {
      function launch() {
        if (done.signal.aborted || next >= URLS.length) return;
        const url = URLS[next++];
        running++;
        const hedge = setTimeout(launch, HEDGE_MS);
        fetch(url, {method: 'POST', body: body, signal: AbortSignal.any([done.signal, AbortSignal.timeout(TIMEOUT_MS)])})
          .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then(json => {
            // Overpass reports a timeout or memory limit as an ordinary reply with no elements and an error remark.
            if (/error/i.test(json.remark || '')) throw new Error(json.remark.trim());
            done.abort();
            resolve(json.elements);
          })
          .catch(e => {
            clearTimeout(hedge);
            running--;
            if (done.signal.aborted) return;
            errors.push(`${new URL(url).host}: ${e.message}`);
            if (next < URLS.length) launch();
            else if (running === 0) reject(new Error('OpenStreetMap lookup failed (' + errors.join('; ') + ')'));
          });
      }
      launch();
    });
  }

  return {nodes: nodes, rivers: rivers};
}());

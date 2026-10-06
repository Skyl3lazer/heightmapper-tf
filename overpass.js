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
  // Past the [timeout:90] every query carries, so a server's own timeout reply arrives before this gives up on it.
  const TIMEOUT_MS = 100000;
  // Bigger boxes are looked up in tiles this size, one after another, so no single river query hits the server's limits.
  const RIVER_TILE_DEGREES = 3;
  // Past this many tiles a lookup runs for minutes, up to thousands of queries for the whole world, so rivers() declines such maps.
  const RIVER_MAX_TILES = 24;

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
  // A box around the whole world is left out, since Overpass searches everywhere about twice as fast, and callers drop nodes outside their box.
  function nodes(bounds, filter) {
    const boxes = bboxes(bounds);
    const parts = boxes[0][3] - boxes[0][1] >= 360 ? `node${filter};` : boxes.map(b => `node${filter}(${b.join(',')});`).join('');
    return run(`[out:json][timeout:90];(${parts});out qt;`);
  }

  // River courses inside bounds at least minLength real meters long, and shorter ones linking them, as [[lat, lon], ...] lines clipped to the box.
  // OpenStreetMap often splits a river into many short pieces, so pieces are first listed with only their name and length, which is small.
  // A named river is judged by the length of all its pieces together, and only the pieces of rivers that pass are fetched with their points.
  // Returns null for a box needing more than RIVER_MAX_TILES tiles.
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
    if (tiles.length > RIVER_MAX_TILES) return null;
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
    const kept = [], short = [];
    for (const [id, piece] of pieces) {
      if ((piece.name ? totals.get(piece.name) : piece.length) >= minLength) kept.push(id);
      else if (piece.name) short.push(id);
    }
    const wanted = tiles.map(() => []);
    for (const id of kept.concat(await links(kept, short, pieces))) pieces.get(id).tiles.forEach(t => wanted[t].push(id));
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

  // The pieces of short named rivers whose two ends meet kept rivers, since leaving out a short reach between kept rivers cuts the waterway in two.
  async function links(kept, short, pieces) {
    if (!kept.length || !short.length) return [];
    const found = await run(`[out:json][timeout:90];way(id:${kept.join(',')});node(w)->.kept;way(id:${short.join(',')})->.short;` +
      'node(w.short)->.nodes;node.nodes.kept->.meets;way.short(bn.meets);out skel qt;.meets out ids qt;');
    const meets = new Set(found.filter(e => e.type === 'node').map(e => e.id));
    const nodes = new Map(found.filter(e => e.type === 'way').map(e => [e.id, e.nodes]));
    const touched = new Map();
    for (const [id, list] of nodes) {
      const name = pieces.get(id).name;
      touched.set(name, new Set([...(touched.get(name) || []), ...list.filter(n => meets.has(n))]));
    }
    const names = new Set([...touched].filter(([, met]) => met.size > 1).map(([name]) => name));
    const missing = short.filter(id => names.has(pieces.get(id).name) && !nodes.has(id));
    if (missing.length) (await run(`[out:json][timeout:90];way(id:${missing.join(',')});out skel qt;`)).forEach(e => nodes.set(e.id, e.nodes));
    const endsOf = id => [nodes.get(id)[0], nodes.get(id)[nodes.get(id).length - 1]];
    const linked = [];
    for (const name of names) {
      const ids = short.filter(id => pieces.get(id).name === name && nodes.has(id)), at = new Map();
      for (const id of ids) endsOf(id).forEach(n => at.set(n, (at.get(n) || []).concat(id)));
      // Separate rivers can share a name, so each run of pieces joined end to end is judged alone.
      const seen = new Set();
      for (const start of ids) {
        if (seen.has(start)) continue;
        const reach = [start];
        seen.add(start);
        for (let i = 0; i < reach.length; i++) {
          for (const id of endsOf(reach[i]).flatMap(n => at.get(n))) {
            if (!seen.has(id)) {
              seen.add(id);
              reach.push(id);
            }
          }
        }
        const ends = new Set(reach.flatMap(endsOf).filter(n => at.get(n).length === 1 && meets.has(n)));
        if (ends.size > 1) linked.push(...reach);
      }
    }
    return linked;
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

  // The next instance is only asked once one fails, so a slow but working query never runs on several servers at once.
  async function run(data) {
    const errors = [];
    for (const url of URLS) {
      let json;
      try {
        const response = await fetch(url, {method: 'POST', body: new URLSearchParams({data: data}), signal: AbortSignal.timeout(TIMEOUT_MS)});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        json = await response.json();
      } catch (e) {
        errors.push(`${new URL(url).host}: ${e.message}`);
        continue;
      }
      // Overpass reports a timeout or memory limit as an ordinary reply with no elements and an error remark.
      // A query too big for one server is too big for the others, so it isn't passed on.
      if (/timed out|out of memory/i.test(json.remark || '')) throw new Error('OpenStreetMap lookup too large (' + json.remark.trim() + ')');
      if (!/error/i.test(json.remark || '')) return json.elements;
      errors.push(`${new URL(url).host}: ${json.remark.trim()}`);
    }
    throw new Error('OpenStreetMap lookup failed (' + errors.join('; ') + ')');
  }

  return {nodes: nodes, rivers: rivers};
}());

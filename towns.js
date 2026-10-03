/*jslint browser: true*/

// Builds a Transport Fever town list from the OpenStreetMap places inside the export box.
var townExport = (function () {
  'use strict';

  // A keyed service from config.js first, then free public instances with global coverage.
  const OVERPASS_URLS = [
    configuredOverpass(),
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ].filter(Boolean);
  const OVERPASS_TIMEOUT_MS = 60000;
  const OVERPASS_HEDGE_MS = 20000;
  const GAME_METERS_PER_PIXEL = 4;
  // Matches the gap the game's own town generator leaves along the map edge.
  const EDGE_MARGIN = 800;
  const SIZE_RANGE = [0.55, 2.6];
  const DEFAULT_POPULATION = {city: 50000, town: 10000, village: 1000};
  const COMMERCIAL_NEEDS = ['vegetables', 'fish', 'meat'];
  const INDUSTRIAL_NEEDS = ['bricks', 'planks', 'fuel'];

  function configuredOverpass() {
    const config = typeof heightmapperConfig === 'undefined' ? {} : heightmapperConfig;
    return (config.overpassUrl || '').replace('{key}', encodeURIComponent(config.overpassKey || ''));
  }

  // A down or overloaded instance shouldn't stall the export, so the next one starts after a short wait or a failure.
  function fetchPlaces(bounds, types) {
    const body = new URLSearchParams({data: `[out:json][timeout:60];node["place"~"^(${types.join('|')})$"]` +
      `(${bounds.south},${bounds.west},${bounds.north},${bounds.east});out;`});
    const done = new AbortController();
    const errors = [];
    let next = 0, running = 0;
    return new Promise((resolve, reject) => {
      function launch() {
        if (done.signal.aborted || next >= OVERPASS_URLS.length) return;
        const url = OVERPASS_URLS[next++];
        running++;
        const hedge = setTimeout(launch, OVERPASS_HEDGE_MS);
        fetch(url, {method: 'POST', body: body, signal: AbortSignal.any([done.signal, AbortSignal.timeout(OVERPASS_TIMEOUT_MS)])})
          .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then(json => {
            done.abort();
            resolve(json.elements);
          })
          .catch(e => {
            clearTimeout(hedge);
            running--;
            if (done.signal.aborted) return;
            errors.push(`${new URL(url).host}: ${e.message}`);
            if (next < OVERPASS_URLS.length) launch();
            else if (running === 0) reject(new Error('OpenStreetMap place lookup failed (' + errors.join('; ') + ')'));
          });
      }
      launch();
    });
  }

  function population(tags) {
    const count = parseInt(String(tags.population || '').replace(/[,\s]/g, ''), 10);
    return count > 0 ? count : DEFAULT_POPULATION[tags.place];
  }

  // The game's own town names are plain ASCII, so accents are dropped rather than risked.
  function asciiName(tags) {
    return String(tags.name || tags['name:en'] || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\x20-\x7e]/g, '').trim();
  }

  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  function snap(meters) {
    return Math.round(meters / GAME_METERS_PER_PIXEL) * GAME_METERS_PER_PIXEL;
  }

  function luaString(text) {
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Same layout as the game's own town files, down to the CRLF line endings.
  function toLua(towns) {
    const lines = ['function data()', 'return { ', '\t\tindustries = { },', '\t\ttowns = {'];
    for (const t of towns) {
      lines.push(
        '\t\t\t{ ',
        '\t\t\t\tlandUse2CargoNeedsCategories = { ',
        '\t\t\t\t\tcom = {', `\t\t\t\t\t\t{ "${t.commercial}", 1, },`, '\t\t\t\t\t},',
        '\t\t\t\t\tind = {', `\t\t\t\t\t\t{ "${t.industrial}", 1, },`, '\t\t\t\t\t},',
        '\t\t\t\t},',
        `\t\t\t\tname = "${luaString(t.name)}",`,
        '\t\t\t\tposition = { ', `\t\t\t\t\tx = ${t.x},`, `\t\t\t\t\ty = ${t.y},`, '\t\t\t\t},',
        `\t\t\t\tsizeFactors = { ${t.size}, ${t.size}, ${t.size}, },`,
        '\t\t\t},');
    }
    lines.push('\t\t},', '\t}', 'end');
    return lines.join('\r\n');
  }

  async function build(options) {
    const {bounds, width, height, maxTowns, minSpacing, includeVillages} = options;
    const places = await fetchPlaces(bounds, includeVillages ? ['city', 'town', 'village'] : ['city', 'town']);
    const nw = heightmapExport.project(bounds.north, bounds.west);
    const se = heightmapExport.project(bounds.south, bounds.east);
    const halfX = (width - 1) / 2 * GAME_METERS_PER_PIXEL;
    const halfY = (height - 1) / 2 * GAME_METERS_PER_PIXEL;

    const candidates = [];
    for (const place of places) {
      const name = asciiName(place.tags);
      if (!name) continue;
      const p = heightmapExport.project(place.lat, place.lon);
      const x = snap(((p.x - nw.x) / (se.x - nw.x) - 0.5) * 2 * halfX);
      const y = snap((0.5 - (p.y - nw.y) / (se.y - nw.y)) * 2 * halfY);
      if (Math.abs(x) > halfX - EDGE_MARGIN || Math.abs(y) > halfY - EDGE_MARGIN) continue;
      candidates.push({name: name, x: x, y: y, lat: place.lat, lng: place.lon, population: population(place.tags)});
    }
    candidates.sort((a, b) => b.population - a.population);

    const towns = [];
    for (const c of candidates) {
      if (towns.length >= maxTowns) break;
      if (towns.every(t => Math.hypot(t.x - c.x, t.y - c.y) >= minSpacing)) towns.push(c);
    }

    const logs = towns.map(t => Math.log(t.population));
    const lo = Math.min(...logs), hi = Math.max(...logs);
    towns.forEach((t, i) => {
      const share = hi > lo ? (logs[i] - lo) / (hi - lo) : 0.5;
      t.size = Number((SIZE_RANGE[0] + share * (SIZE_RANGE[1] - SIZE_RANGE[0])).toFixed(2));
      const h = hash(t.name);
      t.commercial = COMMERCIAL_NEEDS[h % 3];
      t.industrial = INDUSTRIAL_NEEDS[Math.floor(h / 3) % 3];
    });

    return {lua: toLua(towns), towns: towns, candidates: candidates.length};
  }

  return {build: build};
}());

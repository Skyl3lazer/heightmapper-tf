/*jslint browser: true*/

// Builds a Transport Fever town list from the OpenStreetMap places inside the export box.
var townExport = (function () {
  'use strict';

  const GAME_METERS_PER_PIXEL = 4;
  // Matches the gap the game's own town generator leaves along the map edge.
  const EDGE_MARGIN = 800;
  const SIZE_RANGE = [0.55, 2.6];
  const DEFAULT_POPULATION = {city: 50000, town: 10000, village: 1000};
  // Largest place types first. Overpass can't rank by population, so smaller types are fetched only while the larger ones leave the map short of towns.
  const PLACE_TIERS = [['city', 'cities'], ['town', 'towns'], ['village', 'villages']];
  const COMMERCIAL_NEEDS = ['vegetables', 'fish', 'meat'];
  const INDUSTRIAL_NEEDS = ['bricks', 'planks', 'fuel'];

  function population(tags) {
    const count = parseInt(String(tags.population || '').replace(/[,\s]/g, ''), 10);
    return count > 0 ? count : DEFAULT_POPULATION[tags.place];
  }

  // Cyrillic and Greek spell out letter by letter, for places with no Latin name at all.
  const TRANSLIT = {'\u0430': 'a', '\u0431': 'b', '\u0432': 'v', '\u0433': 'g', '\u0434': 'd', '\u0435': 'e', '\u0451': 'yo', '\u0436': 'zh', '\u0437': 'z', '\u0438': 'i', '\u0439': 'y', '\u043a': 'k', '\u043b': 'l', '\u043c': 'm', '\u043d': 'n', '\u043e': 'o', '\u043f': 'p', '\u0440': 'r', '\u0441': 's', '\u0442': 't', '\u0443': 'u', '\u0444': 'f', '\u0445': 'kh', '\u0446': 'ts', '\u0447': 'ch', '\u0448': 'sh', '\u0449': 'shch', '\u044a': '', '\u044b': 'y', '\u044c': '', '\u044d': 'e', '\u044e': 'yu', '\u044f': 'ya', '\u0456': 'i', '\u0457': 'yi', '\u0454': 'ye', '\u0491': 'g', '\u045e': 'u', '\u0458': 'j', '\u0459': 'lj', '\u045a': 'nj', '\u045b': 'c', '\u0452': 'dj', '\u045f': 'dz', '\u0453': 'g', '\u045c': 'k', '\u0455': 'dz', '\u03b1': 'a', '\u03b2': 'v', '\u03b3': 'g', '\u03b4': 'd', '\u03b5': 'e', '\u03b6': 'z', '\u03b7': 'i', '\u03b8': 'th', '\u03b9': 'i', '\u03ba': 'k', '\u03bb': 'l', '\u03bc': 'm', '\u03bd': 'n', '\u03be': 'x', '\u03bf': 'o', '\u03c0': 'p', '\u03c1': 'r', '\u03c3': 's', '\u03c2': 's', '\u03c4': 't', '\u03c5': 'y', '\u03c6': 'f', '\u03c7': 'ch', '\u03c8': 'ps', '\u03c9': 'o', '\u03ac': 'a', '\u03ad': 'e', '\u03ae': 'i', '\u03af': 'i', '\u03cc': 'o', '\u03cd': 'y', '\u03ce': 'o', '\u03ca': 'i', '\u03cb': 'y', '\u0390': 'i', '\u03b0': 'y'};

  // Names in Latin script, accents included. Combining marks and anything that isn't a letter are fine.
  function isLatin(text) {
    return /^[\p{Script=Latin}\P{L}]*$/u.test(text) && /\p{L}/u.test(text);
  }

  // The local name when it's already Latin, then English and international names, then romanizations, then transliteration.
  function latinName(tags) {
    const keys = ['name', 'name:en', 'int_name'].concat(Object.keys(tags).filter(k => /^name:[a-z]+[-_](Latn|rm)/i.test(k)));
    const key = keys.find(k => tags[k] && isLatin(tags[k]));
    const spelled = String(tags.name || '').replace(/./gu, c => {
      const latin = TRANSLIT[c.toLowerCase()];
      if (latin === undefined) return c;
      return c === c.toLowerCase() ? latin : latin.charAt(0).toUpperCase() + latin.slice(1);
    });
    const name = key ? tags[key] : isLatin(spelled) ? spelled : '';
    return name.replace(/\s+/g, ' ').trim();
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
    // waterNear(px, py): resolves true when the site at that output pixel is too close to water. skipDangerous leaves those towns out.
    const {bounds, width, height, maxTowns, minSpacing, includeVillages, originalNames, northLeft, waterNear, skipDangerous} = options;
    const onStage = options.onStage || function () {};
    const nw = heightmapExport.project(bounds.north, bounds.west);
    const se = heightmapExport.project(bounds.south, bounds.east);
    const halfX = (width - 1) / 2 * GAME_METERS_PER_PIXEL;
    const halfY = (height - 1) / 2 * GAME_METERS_PER_PIXEL;

    const centerLng = (bounds.west + bounds.east) / 2;
    const candidates = [];
    let towns = [];
    for (const [tag, plural] of includeVillages ? PLACE_TIERS : PLACE_TIERS.slice(0, 2)) {
      onStage('Looking up ' + plural + '...');
      for (const place of await overpass.nodes(bounds, `["place"="${tag}"]`)) {
        const name = originalNames ? String(place.tags.name || '').trim() : latinName(place.tags);
        if (!name) continue;
        // OpenStreetMap longitudes stay within -180 to 180, so they move to the copy of the world the box is in.
        const lon = place.lon + 360 * Math.round((centerLng - place.lon) / 360);
        const p = heightmapExport.project(place.lat, lon);
        const x = snap(((p.x - nw.x) / (se.x - nw.x) - 0.5) * 2 * halfX);
        const y = snap((0.5 - (p.y - nw.y) / (se.y - nw.y)) * 2 * halfY);
        if (Math.abs(x) > halfX - EDGE_MARGIN || Math.abs(y) > halfY - EDGE_MARGIN) continue;
        candidates.push({name: name, x: northLeft ? -y : x, y: northLeft ? x : y, lat: place.lat, lng: lon, population: population(place.tags),
          px: Math.round(x / GAME_METERS_PER_PIXEL + (width - 1) / 2), py: Math.round((height - 1) / 2 - y / GAME_METERS_PER_PIXEL)});
      }
      candidates.sort((a, b) => b.population - a.population);
      if (waterNear) onStage('Checking town sites...');
      towns = [];
      for (const c of candidates) {
        if (towns.length >= maxTowns) break;
        if (!towns.every(t => Math.hypot(t.x - c.x, t.y - c.y) >= minSpacing)) continue;
        // Only towns that would otherwise be picked get checked, and each only once across the tiers.
        if (waterNear && c.wet === undefined) c.wet = await waterNear(c.px, c.py);
        if (!(skipDangerous && c.wet)) towns.push(c);
      }
      if (towns.length >= maxTowns) break;
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

    return {lua: toLua(towns), towns: towns, candidates: candidates.length, skipped: skipDangerous ? candidates.filter(c => c.wet) : []};
  }

  return {build: build};
}());

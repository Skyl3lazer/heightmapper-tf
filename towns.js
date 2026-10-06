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
  // The last value is the most real km2 a type is looked up over, past which its lookup runs into Overpass's time limit.
  const PLACE_TIERS = [['city', 'cities', Infinity], ['town', 'towns', 1e6], ['village', 'villages', 2.5e5]];
  const COMMERCIAL_NEEDS = ['vegetables', 'fish', 'meat'];
  const INDUSTRIAL_NEEDS = ['bricks', 'planks', 'fuel'];
  // The game starts every town with one straight street centered on its position. A town whose street can't be built never grows.
  const STREET_HALF_LENGTH = 44;
  // The game's limits are 0.40 and 8 m. Its heights differ from bilinear sampling by up to 0.75 m, so these keep a margin.
  const MAX_STREET_GRADE = 0.38;
  const MIN_WATER_GAP = 9;
  // In-game water covers this far around each height sample at or below the water level.
  const WATER_CELL_HALF = 4;

  // The game seeds one minstd_rand step with the position, so every meter a town moves turns its street.
  function streetAngle(x, y) {
    let seed = ((Math.trunc(x) + Math.trunc(y)) >>> 0) % 2147483647;
    if (seed === 0) seed = 1;
    const next = (seed * 48271) % 2147483647;
    return Math.fround(Math.fround(Math.fround(Math.fround(next) - 1) * Math.fround(2 ** -31)) * Math.fround(6.2831855));
  }

  // Street checks for towns near the center of a patch of real heights 2 r + 1 output pixels wide, north up.
  // Positions u and v are meters east and north of the patch center.
  function streetTester(heights, r, waterline, heightScale) {
    const size = 2 * r + 1, half = r * GAME_METERS_PER_PIXEL, span = 2 * half + 1;
    const water = new Uint8Array(span * span);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        if (heights[j * size + i] > waterline) continue;
        const a = i * GAME_METERS_PER_PIXEL, b = j * GAME_METERS_PER_PIXEL;
        for (let y = Math.max(0, b - WATER_CELL_HALF); y <= Math.min(span - 1, b + WATER_CELL_HALF); y++) {
          water.fill(1, y * span + Math.max(0, a - WATER_CELL_HALF), y * span + Math.min(span - 1, a + WATER_CELL_HALF) + 1);
        }
      }
    }
    // Everything closer to water than a street may come, on a 1 m grid.
    // Street points round to the nearest cell, so the band reaches half a cell diagonal further to stay on the safe side.
    const gap = MIN_WATER_GAP + Math.SQRT1_2, edge = Math.ceil(gap);
    const blocked = water.slice(), disk = [];
    for (let y = -edge; y <= edge; y++) {
      for (let x = -edge; x <= edge; x++) if (x * x + y * y < gap * gap) disk.push(y * span + x);
    }
    for (let y = edge; y < span - edge; y++) {
      for (let x = edge; x < span - edge; x++) {
        const k = y * span + x;
        if (water[k] && !(water[k - 1] && water[k + 1] && water[k - span] && water[k + span])) disk.forEach(o => { blocked[k + o] = 1; });
      }
    }
    const cell = (u, v) => (half - Math.round(v)) * span + Math.round(u) + half;
    const level = (u, v) => {
      const fi = r + u / GAME_METERS_PER_PIXEL, fj = r - v / GAME_METERS_PER_PIXEL;
      const i = Math.min(Math.floor(fi), size - 2), j = Math.min(Math.floor(fj), size - 2), x = fi - i, y = fj - j, k = j * size + i;
      return heightScale * ((heights[k] * (1 - x) + heights[k + 1] * x) * (1 - y) + (heights[k + size] * (1 - x) + heights[k + size + 1] * x) * y);
    };
    return {
      // What stops the street of a town at (u, v), running along (du, dv), from being built.
      problems: function (u, v, du, dv) {
        const problems = [];
        const rise = level(u + STREET_HALF_LENGTH * du, v + STREET_HALF_LENGTH * dv) - level(u - STREET_HALF_LENGTH * du, v - STREET_HALF_LENGTH * dv);
        if (Math.abs(rise) / (2 * STREET_HALF_LENGTH) > MAX_STREET_GRADE) problems.push('too steep');
        for (let s = -STREET_HALF_LENGTH; s <= STREET_HALF_LENGTH; s += 0.5) {
          if (blocked[cell(u + s * du, v + s * dv)]) {
            problems.push('near water');
            break;
          }
        }
        return problems;
      },
      // Whether (u, v) joins the center over land within reach, starting from the nearest shore when the center is in water.
      connected: function (reach) {
        const inReach = k => (k % span - half) ** 2 + (Math.floor(k / span) - half) ** 2 <= reach * reach;
        const reached = new Uint8Array(span * span), queue = [];
        let nearest = Infinity;
        for (let k = 0; k < span * span; k++) {
          const d = (k % span - half) ** 2 + (Math.floor(k / span) - half) ** 2;
          if (water[k] || d > reach * reach || d > nearest) continue;
          if (d < nearest) queue.length = 0;
          nearest = d;
          queue.push(k);
        }
        queue.forEach(k => { reached[k] = 1; });
        // Four neighbors, so land touching only at a corner doesn't count as connected across the water between.
        for (let n = 0; n < queue.length; n++) {
          const k = queue[n], x = k % span;
          for (const q of [x > 0 ? k - 1 : -1, x < span - 1 ? k + 1 : -1, k - span, k + span]) {
            if (q >= 0 && q < span * span && !water[q] && !reached[q] && inReach(q)) {
              reached[q] = 1;
              queue.push(q);
            }
          }
        }
        return (u, v) => reached[cell(u, v)] === 1;
      }
    };
  }

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
    // terrainPatch(px, py, radius): resolves to the real heights in meters of the output pixels within radius of (px, py), north up.
    // waterline: real meters at or below which the map is water. heightScale: in-game meters per real meter.
    // reach: whole in-game meters a town may move to a position whose street can be built. overLand: the move may not cross water.
    // keepUnsafe: a town with no such position stays where it is instead of being skipped.
    const {bounds, width, height, maxTowns, minSpacing, includeVillages, originalNames, northLeft, terrainPatch, waterline, heightScale, overLand, keepUnsafe} = options;
    const reach = options.reach || 0;
    const onStage = options.onStage || function () {};
    const nw = heightmapExport.project(bounds.north, bounds.west);
    const se = heightmapExport.project(bounds.south, bounds.east);
    const halfX = (width - 1) / 2 * GAME_METERS_PER_PIXEL;
    const halfY = (height - 1) / 2 * GAME_METERS_PER_PIXEL;
    const moves = [];
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) if (dx * dx + dy * dy <= reach * reach) moves.push([dx, dy]);
    }
    moves.sort((a, b) => a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1]);

    // Moves and street angles are in the game's frame, which a landscape export turns against the patch's east and north.
    const turn = (dx, dy) => northLeft ? [dy, -dx] : [dx, dy];
    function problemsAt(tester, c, dx, dy) {
      const [u, v] = turn(dx, dy), angle = streetAngle(c.x + dx, c.y + dy);
      const [du, dv] = turn(Math.cos(angle), Math.sin(angle));
      return tester.problems(u, v, du, dv);
    }

    // Sets c.town to the town to export for candidate c, or null to skip it. A town that needs a nudge keeps its tester for nudge instead.
    async function check(c) {
      const r = Math.ceil((reach + STREET_HALF_LENGTH + MIN_WATER_GAP + WATER_CELL_HALF) / GAME_METERS_PER_PIXEL) + 1;
      const tester = streetTester(await terrainPatch(c.px, c.py, r), r, waterline, heightScale);
      c.problems = problemsAt(tester, c, 0, 0);
      if (!c.problems.length) c.town = c;
      else if (!reach) c.town = keepUnsafe ? c : null;
      else c.tester = tester;
    }

    // The town at the nearest position within reach whose street can be built, or null if there is none.
    function nudge(c) {
      const tester = c.tester;
      delete c.tester;
      const east = (c.px - (width - 1) / 2) * GAME_METERS_PER_PIXEL, north = ((height - 1) / 2 - c.py) * GAME_METERS_PER_PIXEL;
      const connected = overLand ? tester.connected(reach) : null;
      for (const [dx, dy] of moves) {
        const [u, v] = turn(dx, dy);
        if (Math.abs(east + u) > halfX - EDGE_MARGIN || Math.abs(north + v) > halfY - EDGE_MARGIN) continue;
        if ((!dx && !dy) || (connected && !connected(u, v)) || problemsAt(tester, c, dx, dy).length) continue;
        const px = c.px + u / GAME_METERS_PER_PIXEL, py = c.py - v / GAME_METERS_PER_PIXEL;
        const p = heightmapExport.unproject(nw.x + px / (width - 1) * (se.x - nw.x), nw.y + py / (height - 1) * (se.y - nw.y));
        return Object.assign({}, c, {x: c.x + dx, y: c.y + dy, px: px, py: py, lat: p.lat, lng: p.lng, from: c, moved: Math.hypot(dx, dy)});
      }
      return null;
    }

    const centerLng = (bounds.west + bounds.east) / 2;
    const candidates = [];
    const areaKm2 = heightmapExport.groundWidth(bounds) * heightmapExport.groundHeight(bounds) / 1e6;
    let towns = [], skipped = [], nudgesDone = 0, nudgesDue = 0, note = null;
    for (const [tag, plural, maxKm2] of includeVillages ? PLACE_TIERS : PLACE_TIERS.slice(0, 2)) {
      if (areaKm2 > maxKm2) {
        note = plural + ' not looked up, the map covers too much ground';
        break;
      }
      onStage('Looking up ' + plural + '...');
      let places;
      try {
        places = await overpass.nodes(bounds, `["place"="${tag}"]`);
      } catch (e) {
        // Smaller places only fill out a map, so the towns already placed are kept.
        if (!candidates.length) throw e;
        note = plural + ' left out because ' + e.message;
        break;
      }
      for (const place of places) {
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
      // Nudges run in batches between passes so the progress bar knows how many are due.
      // A nudge can free a place or crowd a neighbor, which the next pass settles.
      for (;;) {
        // Progress counts towns placed against the most this tier can place.
        const target = Math.max(1, Math.min(maxTowns, candidates.length));
        onStage('Checking town streets...', 0);
        towns = [];
        skipped = [];
        const waiting = [];
        for (const c of candidates) {
          if (towns.length >= maxTowns) break;
          // Only towns that could still be picked get checked, and each only once across the tiers.
          if (!towns.every(t => Math.hypot(t.x - c.x, t.y - c.y) + reach >= minSpacing)) continue;
          if (c.town === undefined && !c.tester) {
            onStage('Checking town streets...', towns.length / target);
            await check(c);
          }
          // A town waiting for its nudge holds its place where it is for now.
          if (c.town === undefined) waiting.push(c);
          const town = c.town === undefined ? c : c.town;
          if (!town) skipped.push(c);
          else if (towns.every(t => Math.hypot(t.x - town.x, t.y - town.y) >= minSpacing)) towns.push(town);
        }
        if (!waiting.length) break;
        nudgesDue += waiting.length;
        for (const c of waiting) {
          onStage('Nudging town ' + (nudgesDone + 1) + ' of ' + nudgesDue + '...', nudgesDone / nudgesDue);
          await heightmapExport.yieldToPage();
          c.town = nudge(c);
          nudgesDone++;
        }
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

    return {lua: toLua(towns), towns: towns, candidates: candidates.length, skipped: skipped, note: note};
  }

  return {build: build};
}());

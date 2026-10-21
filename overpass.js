/*jslint browser: true*/

var overpass = (function () {
  'use strict';

  // A keyed service from config.js first, then free public instances with global coverage.
  const URLS = [
    configuredUrl(),
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ].filter(Boolean);
  // Past the [timeout:90] every query carries, so that a server's own timeout reply arrives before this gives up on it.
  const TIMEOUT_MS = 100000;
  // Bigger boxes are looked up in tiles this size, one after another, so that no single river query hits the server's limits.
  const RIVER_TILE_DEGREES = 3;
  // Past this many tiles a lookup runs for minutes, up to thousands of queries for the whole world.
  const RIVER_MAX_TILES = 24;
  // Real meters between one river's end and the start of another of the same name that join them as one river with a stretch left out.
  const RIVER_GAP_JOIN = 6000;
  // Real meters from a same-named river's course within which a piece's end makes it an arm of that river.
  const RIVER_ARM_REACH = 100;

  function configuredUrl() {
    const config = typeof heightmapperConfig === 'undefined' ? {} : heightmapperConfig;
    return (config.overpassUrl || '').replace('{key}', encodeURIComponent(config.overpassKey || ''));
  }

  // Overpass only takes longitudes from -180 to 180. A box crossing the antimeridian splits into one box each side.
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
  // A box around the whole world is left out, since Overpass searches everywhere about twice as fast. Callers drop nodes outside their box.
  function nodes(bounds, filter) {
    // A box capped at one copy of the world comes out a hair under 360 degrees wide.
    const parts = bounds.east - bounds.west >= 360 - 1e-3 ? `node${filter};` : bboxes(bounds).map(b => `node${filter}(${b.join(',')});`).join('');
    return run(`[out:json][timeout:90];(${parts});out qt;`);
  }

  // State borders inside bounds, as lines [[lat, lon], ...] clipped to the box in the box's copy of the world. Borders out at sea are left out.
  // The few countries in the box come first. Searching every way in a big box for border tags instead takes about three times as long.
  async function borders(bounds) {
    const boxes = bboxes(bounds), centerLng = (bounds.west + bounds.east) / 2;
    const countries = boxes.map(box => `rel["boundary"="administrative"]["admin_level"="2"](${box});`).join('');
    const ways = boxes.map(box => `way(r.c)["maritime"!="yes"](${box});`).join('');
    const output = boxes.length === 1 ? `out ids geom(${boxes[0]}) qt;` : 'out ids geom qt;';
    return (await run(`[out:json][timeout:90];(${countries})->.c;(${ways});${output}`)).flatMap(way => splitAtGaps(way, centerLng));
  }

  // Rivers inside bounds at least minLength real meters long, and shorter ones linking them, or null past RIVER_MAX_TILES tiles.
  // Each is {key, name, where, length, width, widthShare, lines, connects}: where is [lat, lon] on a river sharing its name with others in the box, or null,
  // length in real meters for the whole river, width in real meters from its width tags or NaN, widthShare the share of its pieces' length those tags are on,
  // lines as [[lat, lon], ...] clipped to the box in the box's copy of the world, and connects the keys of the rivers a linking river joins, or null.
  // OpenStreetMap often splits a river into many short pieces. A named river is judged by the length of all its pieces together, or of its waterway relation when that's longer.
  // Many separate streams share a name, like Czarna, so a name's pieces are split into rivers again by how they join.
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
    const pieces = new Map(), full = new Map(), relations = new Set();
    for (const [t, boxes] of tiles.entries()) {
      const ways = boxes.map(box => `way["waterway"="river"](${box});`).join('');
      for (const e of await run(`[out:json][timeout:90];(${ways})->.w;.w convert river ::id=id(),name=t["name"],len=length(),width=t["width"];out;` +
        'rel(bw.w)["type"="waterway"]["waterway"="river"];out ids qt;')) {
        if (e.type === 'relation') {
          relations.add(e.id);
          continue;
        }
        if (!pieces.has(e.id)) {
          const piece = {key: e.tags.name || 'way/' + e.id, name: e.tags.name, length: Number(e.tags.len), width: parseWidth(e.tags.width), tiles: []};
          pieces.set(e.id, piece);
          full.set(piece.key, (full.get(piece.key) || 0) + piece.length);
        }
        pieces.get(e.id).tiles.push(t);
      }
    }
    await relationLengths(relations, pieces, full);
    const kept = [], short = [];
    for (const [id, piece] of pieces) {
      if (full.get(piece.key) >= minLength) kept.push(id);
      else if (piece.name) short.push(id);
    }
    const taken = new Map(), wanted = tiles.map(() => []);
    kept.forEach(id => taken.set(id, null));
    (await links(kept, short, pieces)).forEach(reach => reach.ids.forEach(id => taken.set(id, reach.connects)));
    taken.forEach((connects, id) => pieces.get(id).tiles.forEach(t => wanted[t].push(id)));
    const centerLng = (bounds.west + bounds.east) / 2, lines = new Map();
    for (const [t, boxes] of tiles.entries()) {
      if (!wanted[t].length) continue;
      const ways = boxes.map(box => `way(id:${wanted[t].join(',')})(${box});`).join('');
      // Clipping to the box leaves out the rest of long rivers, which is most of the download on a small map.
      const output = boxes.length === 1 ? `out ids geom(${boxes[0]}) qt;` : 'out ids geom qt;';
      for (const way of await run(`[out:json][timeout:90];(${ways});${output}`)) lines.set(way.id, (lines.get(way.id) || []).concat(splitAtGaps(way, centerLng)));
    }
    // A stream split off a longer one of the same name is judged by its own length, unless it links rivers.
    const systems = riverSystems([...taken.keys()].filter(id => lines.has(id)), pieces, lines).filter(system =>
      system.ids.some(id => taken.get(id)) || Math.max(...system.ids.map(id => pieces.get(id).relation || 0), system.ids.reduce((sum, id) => sum + pieces.get(id).length, 0)) >= minLength);
    const keyOf = new Map();
    systems.forEach(system => system.ids.forEach(id => keyOf.set(id, system.key)));
    return systems.map(system => {
      const widths = [], connects = new Set();
      let length = 0, measured = 0;
      for (const id of system.ids) {
        const piece = pieces.get(id);
        length += piece.length;
        measured = Math.max(measured, piece.relation || 0);
        if (piece.width > 0) widths.push([piece.width, piece.length]);
        (taken.get(id) || []).forEach(way => { if (keyOf.has(way)) connects.add(keyOf.get(way)); });
      }
      return {
        key: system.key, name: system.name, where: system.where, length: Math.max(length, measured),
        width: weightedMedian(widths), widthShare: widths.reduce((sum, [, len]) => sum + len, 0) / length,
        lines: system.ids.flatMap(id => lines.get(id)), connects: system.ids.some(id => taken.get(id)) ? [...connects] : null
      };
    });
  }

  // Splits the pieces sharing a key into rivers: pieces joined end to end, pieces of one waterway relation, an arm whose end lies on the river's course,
  // and a river's end within RIVER_GAP_JOIN real meters of another's start, which bridges a stretch OpenStreetMap leaves out.
  // The longest river of a name keeps it as its key.
  // ids: the pieces to split. lines: each piece's lines, as splitAtGaps gives them. Returns [{key, name, where, ids}].
  function riverSystems(ids, pieces, lines) {
    const parent = new Map(ids.map(id => [id, id]));
    const find = id => parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id));
    const join = (a, b) => parent.set(find(a), find(b));
    const groups = new Map();
    ids.forEach(id => groups.set(pieces.get(id).key, (groups.get(pieces.get(id).key) || []).concat(id)));
    const point = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);
    const systems = [];
    for (const [key, group] of groups) {
      const at = new Map(), relation = new Map();
      for (const id of group) {
        for (const line of lines.get(id)) {
          for (const p of [line[0], line[line.length - 1]]) {
            if (at.has(point(p))) join(id, at.get(point(p)));
            else at.set(point(p), id);
          }
        }
        const rel = pieces.get(id).relationId;
        if (rel) {
          if (relation.has(rel)) join(id, relation.get(rel));
          else relation.set(rel, id);
        }
      }
      // Ways point downstream. A river's end is the last point of a line no other line of it goes on from, and its start the first point no line ends at.
      const parts = () => {
        const byRoot = new Map();
        group.forEach(id => byRoot.set(find(id), (byRoot.get(find(id)) || []).concat(id)));
        return [...byRoot.values()];
      };
      let split = parts();
      if (split.length > 1) {
        const ends = split.map(part => {
          const all = part.flatMap(id => lines.get(id)), firsts = new Set(all.map(l => point(l[0]))), lasts = new Set(all.map(l => point(l[l.length - 1])));
          return {starts: all.map(l => l[0]).filter(p => !lasts.has(point(p))), ends: all.map(l => l[l.length - 1]).filter(p => !firsts.has(point(p))), id: part[0]};
        });
        for (const a of ends) {
          for (const b of ends) {
            if (a !== b && a.ends.some(p => b.starts.some(q => groundDistance(p, q) <= RIVER_GAP_JOIN))) join(a.id, b.id);
          }
        }
        split = parts();
        for (const a of split) {
          const own = ends.filter(e => find(e.id) === find(a[0])).flatMap(e => e.starts.concat(e.ends));
          for (const b of split) {
            if (find(a[0]) === find(b[0])) continue;
            if (b.some(id => lines.get(id).some(l => own.some(p => nearBox(p, l) && lineDistance(p, l) <= RIVER_ARM_REACH)))) join(a[0], b[0]);
          }
        }
        split = parts();
      }
      const sized = split.map(part => ({part: part, length: part.reduce((sum, id) => sum + pieces.get(id).length, 0)})).sort((a, b) => b.length - a.length);
      sized.forEach(({part}, i) => {
        const first = lines.get(part[0])[0][0];
        // A stream sharing its name is keyed by its lowest way id, which stays the same when the box moves a little.
        systems.push({key: i === 0 ? key : key + '#' + Math.min(...part), name: /^(way|rel)\//.test(key) ? null : key,
          where: sized.length > 1 ? [Number(first[0].toFixed(2)), Number(first[1].toFixed(2))] : null, ids: part});
      });
    }
    return systems;
  }

  // Whether a [lat, lon] point lies within RIVER_ARM_REACH of a line's bounding box, which is cached per line.
  const boxes = new WeakMap();
  function nearBox(p, line) {
    if (!boxes.has(line)) {
      const lats = line.map(q => q[0]), lngs = line.map(q => q[1]);
      boxes.set(line, [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)]);
    }
    const [s, n, w, e] = boxes.get(line), dLat = RIVER_ARM_REACH / 111320, dLng = dLat / Math.cos(p[0] * Math.PI / 180);
    return p[0] >= s - dLat && p[0] <= n + dLat && p[1] >= w - dLng && p[1] <= e + dLng;
  }

  // Real meters from a [lat, lon] point to the nearest point of a line of them.
  function lineDistance(p, line) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const scale = Math.cos(p[0] * Math.PI / 180), ax = (line[i - 1][1] - p[1]) * scale, ay = line[i - 1][0] - p[0];
      const dx = (line[i][1] - p[1]) * scale - ax, dy = line[i][0] - p[0] - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t) * 111320);
    }
    return best;
  }

  // Real meters between two [lat, lon] points, near enough for distances of a few km.
  function groundDistance(a, b) {
    const dy = (a[0] - b[0]) * 111320, dx = (a[1] - b[1]) * 111320 * Math.cos((a[0] + b[0]) / 2 * Math.PI / 180);
    return Math.hypot(dx, dy);
  }

  // Waterway relations measure a river past the box, and past pieces named differently, like a river whose name changes at a border.
  // They only lengthen what the pieces add up to in full, keyed as pieces are. A failed lookup leaves the pieces' sums.
  async function relationLengths(ids, pieces, full) {
    if (!ids.size) return;
    let found;
    try {
      found = await run(`[out:json][timeout:90];rel(id:${[...ids].join(',')});out body qt;convert waterway ::id=id(),len=length();out;`);
    } catch (e) {
      return;
    }
    const lengths = new Map(found.filter(e => e.type === 'waterway').map(e => [e.id, Number(e.tags.len)]));
    for (const e of found) {
      if (e.type !== 'relation' || !(lengths.get(e.id) > 0)) continue;
      // Side streams and the like belong to the relation without being the river's own course.
      const members = (e.members || []).filter(m => m.type === 'way' && (!m.role || m.role === 'main_stream') && pieces.has(m.ref)).map(m => pieces.get(m.ref));
      // The river's pieces, unnamed ones and ones named in other languages or for its arms, join it under the name the most of its length carries.
      const counts = new Map();
      members.forEach(piece => { if (piece.name) counts.set(piece.key, (counts.get(piece.key) || 0) + piece.length); });
      // A relation of unnamed pieces is one river all the same, under the relation's own name if it has one.
      const named = [...counts].sort((a, b) => b[1] - a[1]).map(([key]) => key)[0] || (e.tags && e.tags.name) || 'rel/' + e.id;
      for (const piece of members) {
        piece.key = named;
        if (!piece.name && !named.startsWith('rel/')) piece.name = named;
        piece.relationId = e.id;
        piece.relation = Math.max(piece.relation || 0, lengths.get(e.id));
        full.set(piece.key, Math.max(full.get(piece.key) || 0, lengths.get(e.id)));
      }
    }
  }

  // Meters from a width tag such as "25", "25 m", "20-30" or "80 ft", or NaN.
  function parseWidth(text) {
    const numbers = String(text || '').match(/\d+(?:\.\d+)?/g);
    if (!numbers) return NaN;
    const mean = numbers.reduce((sum, n) => sum + Number(n), 0) / numbers.length;
    return /ft|'/.test(text) ? mean * 0.3048 : mean;
  }

  // The value with half of the weight on either side, from [value, weight] pairs, or NaN without any.
  function weightedMedian(pairs) {
    const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
    let half = sorted.reduce((sum, [, w]) => sum + w, 0) / 2;
    for (const [v, w] of sorted) if ((half -= w) <= 0) return v;
    return NaN;
  }

  // The pieces of short named rivers whose two ends meet kept rivers, since leaving out a short reach between kept rivers cuts the waterway in two.
  // Returns each reach as {ids, connects}: its pieces, and the ids of the kept pieces at its ends.
  async function links(kept, short, pieces) {
    if (!kept.length || !short.length) return [];
    const found = await run(`[out:json][timeout:90];way(id:${kept.join(',')})->.kw;node(w.kw)->.kept;way(id:${short.join(',')})->.short;` +
      'node(w.short)->.nodes;node.nodes.kept->.meets;way.short(bn.meets);out skel qt;way.kw(bn.meets);out skel qt;.meets out ids qt;');
    const meets = new Set(found.filter(e => e.type === 'node').map(e => e.id));
    const keptIds = new Set(kept), nodes = new Map(), meeting = new Map();
    for (const e of found) {
      if (e.type !== 'way') continue;
      if (!keptIds.has(e.id)) nodes.set(e.id, e.nodes);
      else e.nodes.filter(n => meets.has(n)).forEach(n => meeting.set(n, (meeting.get(n) || new Set()).add(e.id)));
    }
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
      // Separate rivers can share a name. Each run of pieces joined end to end is judged alone.
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
        if (ends.size > 1) linked.push({ids: reach, connects: [...ends].flatMap(n => [...(meeting.get(n) || [])])});
      }
    }
    return linked;
  }

  // Clipped geometry marks points outside the box as null. A line must not jump across that gap.
  // OpenStreetMap longitudes stay within -180 to 180. They move to the copy of the world around centerLng.
  function splitAtGaps(way, centerLng) {
    const lines = [];
    let line = [];
    for (const p of way.geometry || []) {
      if (p) {
        line.push([p.lat, p.lon + 360 * Math.round((centerLng - p.lon) / 360)]);
      } else {
        if (line.length > 1) lines.push(line);
        line = [];
      }
    }
    if (line.length > 1) lines.push(line);
    return lines;
  }

  // The instance that last answered goes first. A river lookup makes several queries, and an instance that hangs would make each wait out TIMEOUT_MS.
  let lastGood = URLS[0];

  // The next instance is only asked once one fails, so that a slow but working query never runs on several servers at once.
  async function run(data) {
    const errors = [];
    for (const url of [lastGood].concat(URLS.filter(u => u !== lastGood))) {
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
      // A query too big for one server is too big for the others.
      if (/timed out|out of memory/i.test(json.remark || '')) throw new Error('OpenStreetMap lookup too large (' + json.remark.trim() + ')');
      if (!/error/i.test(json.remark || '')) {
        lastGood = url;
        return json.elements;
      }
      errors.push(`${new URL(url).host}: ${json.remark.trim()}`);
    }
    throw new Error('OpenStreetMap lookup failed (' + errors.join('; ') + ')');
  }

  return {nodes: nodes, rivers: rivers, borders: borders};
}());

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
  // A down or overloaded instance shouldn't stall the export, so the next one starts after a short wait or a failure.
  function nodes(bounds, filter) {
    const parts = bboxes(bounds).map(b => `node${filter}(${b.join(',')});`).join('');
    const body = new URLSearchParams({data: `[out:json][timeout:90];(${parts});out qt;`});
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

  return {nodes: nodes};
}());

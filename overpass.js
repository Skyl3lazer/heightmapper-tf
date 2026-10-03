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
  const TIMEOUT_MS = 60000;
  const HEDGE_MS = 20000;

  function configuredUrl() {
    const config = typeof heightmapperConfig === 'undefined' ? {} : heightmapperConfig;
    return (config.overpassUrl || '').replace('{key}', encodeURIComponent(config.overpassKey || ''));
  }

  // The nodes inside bounds matching an Overpass tag filter such as ["natural"="volcano"].
  // A down or overloaded instance shouldn't stall the export, so the next one starts after a short wait or a failure.
  function nodes(bounds, filter) {
    const body = new URLSearchParams({data: `[out:json][timeout:60];node${filter}` +
      `(${bounds.south},${bounds.west},${bounds.north},${bounds.east});out;`});
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

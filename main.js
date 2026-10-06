/*jslint browser: true*/
/*global Tangram, gui */

map = (function () {
  'use strict';
  
  var map_start_location = [0, 0, 2];
  var moving = false;
  var analysis = null;
  var analysisGeneration = 0;
  // What the user typed into whichever of height scale and steepness "scale by" picks. Auto mode may show less so high peaks fit under the game's limit.
  var requestedText = '1';
  var steepnessWarning, heightScaleHint, climateHint, waterHint, bitDepthHint, scaleCapHint, townNamesHint;
  var signs = [];
  // The climate follows the analysis's suggestion until the user picks a different one.
  var climateFollows = true;
  var exportFolder;
  const exportDefaults = {lat: 39.109328, lng: -76.813227, metersPerPixel: 10};
  const RATIOS = ['1:1', '1:2', '1:3', '1:4', '1:5'];
  const CLIMATES = ['Temperate', 'Dry', 'Tropical', 'Subarctic'];
  // Lowest Minimum Height and highest Maximum Height the game's import dialog accepts.
  const GAME_MIN_HEIGHT = -100;
  const GAME_MAX_HEIGHT = 3177;
  const GAME_METERS_PER_PIXEL = 4;
  // In-game meters the export carves water below the water level, so no surface sits exactly on it.
  const WATER_DEPTH = 0.5;
  // Real meters above a flat water surface that still count as its shore, since elevation data is about this noisy at the waterline.
  const SHORE_TOLERANCE = 0.5;
  // Steepness above this tends to look out of place in the game.
  const STEEPNESS_WARNING = 4;
  // In-game meters the nudge options may move a town to find a spot where its first street works.
  const TOWN_NUDGE_REACH = 200;
  // In-game meters. Shorter rivers are left out of water normalization, so maps covering a lot of real ground only fetch rivers that show at their scale.
  const RIVER_MIN_LENGTH = 2000;
  // Unicode has no Erlenmeyer flask, so experimental options take the alembic, another piece of lab glassware.
  const SIGN_GLYPHS = {warning: '\u26a0\ufe0e', info: '\u24d8', experimental: '\u2697\ufe0e'};
  const SETTINGS_KEY = 'heightmapper-settings', CONSENT_KEY = 'heightmapper-remember';
  // Panel choices kept between visits. Climate, the heights and the view follow the place on the map, so they aren't kept.
  const SAVED_SETTINGS = ['include_oceans', 'reference_map', 'mapSize', 'ratio', 'orientation', 'scaleMode', 'smoothing', 'oceanFloor', 'bitDepth',
    'waterNormalization', 'maxTowns', 'townSpacing', 'includeVillages', 'townNames', 'townSafety', 'fileName'];
  // The game has one water level, so a lake's level drowns all lower land. Auto mode skips levels drowning more than this share of the map.
  const MAX_FLOOD_SHARE = 0.15;
  // ...and levels drowning more than this many times the water body's own area, like a tiny flat patch at the bottom of a dry valley.
  const MAX_FLOOD_RATIO = 4;
  // Official in-game size in km, [short side, long side], for each ratio 1:1 to 1:5.
  const MAP_SIZES = {
    'Tiny': [[4, 4], [2.5, 5], [2, 6], [2, 8], [1.5, 7.5]],
    'Small': [[8, 8], [5.5, 11], [4.5, 13.5], [4, 16], [3.5, 17.5]],
    'Medium': [[11, 11], [8, 16], [6.5, 19.5], [6, 24], [5, 25]],
    'Large': [[14, 14], [10, 20], [8, 24], [7, 28], [6, 31.5]],
    'Very Large': [[16, 16], [11, 22], [9, 27], [8, 32], [7, 35]],
    'Huge': [[20, 20], [14, 28], [11.5, 34.5], [10, 40], [8.5, 42.5]],
    'Megalomaniac': [[24, 24], [16.5, 33], [13.5, 40.5], [12, 48], [10.5, 52.5]],
    'Gigantomaniac (TF3)': [[28, 28], [20, 40], [16, 48], [14, 56], [12.5, 62.5]]
  };
  
  /*** URL parsing ***/
  
  // leaflet-style URL hash pattern:
  // #[zoom],[lat],[lng]
  var url_hash = window.location.hash.slice(1, window.location.hash.length).split('/');
  
  if (url_hash.length == 3) {
    map_start_location = [url_hash[1],url_hash[2], url_hash[0]];
    // convert from strings
    map_start_location = map_start_location.map(Number);
  }
  
  var query = splitQueryParams();
  // { language: 'en', this: 'no'}
  
  function splitQueryParams () {
    var str = window.location.search;
    
    var kvArray = str.slice(1).split('&');
    // ['language=en', 'this=no']
    
    var obj = {};
    
    for (var i = 0, j=kvArray.length; i<j; i++) {
      var value = kvArray[i].split('=');
      var k = window.decodeURIComponent(value[0]);
      var v = window.decodeURIComponent(value[1]);
      
      obj[k] = v;
    }
    
    return obj;
  }
  
  /*** Map ***/
  
  var map = L.map('map',
  {"keyboardZoomOffset" : .05,
  "inertiaDeceleration" : 10000,
  "zoomSnap" : 0}
  );
  
  var layer = Tangram.leafletLayer({
    scene: 'scene.yaml',
    attribution: 'Map by <a href="https://mapzen.com/tangram" target="_blank">Tangram</a>, for TF by <a href="https://linktr.ee/skyl3lazer" target="_blank">Skyl3lazer</a> | <a href="https://github.com/tangrams/heightmapper" target="_blank">Fork This</a>'
  });
  
  // from https://davidwalsh.name/javascript-debounce-function
  function debounce(func, wait, immediate) {
    var timeout;
    return function() {
      var context = this, args = arguments;
      var later = function() {
        timeout = null;
        if (!immediate) func.apply(context, args);
      };
      var callNow = immediate && !timeout;
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
      if (callNow) func.apply(context, args);
    };
  };
  
  function linkFromBlob(blob) {
    var urlCreator = window.URL || window.webkitURL;
    return urlCreator.createObjectURL( blob );
  }
  
  window.layer = layer;
  var scene = layer.scene;
  window.scene = scene;
  
  var startAtDefaults = url_hash.length != 3;
  if (startAtDefaults) {
    map.setView([exportDefaults.lat, exportDefaults.lng], 10);
  } else {
    // setView expects format ([lat, long], zoom)
    map.setView(map_start_location.slice(0, 3), map_start_location[2]);
  }
  
  let hash = new L.Hash(map);
  
  var referenceLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    opacity: 0.4,
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
  });
  var townLayer = L.layerGroup();

  // Create dat GUI
  var gui;
  function addGUI () {
    gui.domElement.parentNode.style.zIndex = 5; // make sure GUI is on top of map
    window.gui = gui;
    // Text fields because this dat.gui version rounds number boxes to the precision of their initial value.
    gui.maxHeight = '';
    gui.minHeight = '';
    gui.waterLevel = '';
    onEdit(gui.add(gui, 'maxHeight').name('maximum height'), function(value) {
      if (gui.scaleMode == 'max height') scaleChanged(value);
      else applyManualHeights();
    });
    onEdit(gui.add(gui, 'minHeight').name('minimum height'), applyManualHeights);
    waterHint = addSign(onEdit(gui.add(gui, 'waterLevel').name('water level'), applyManualHeights), 'info');

    gui.autoexpose = true;
    gui.add(gui, 'autoexpose').name("auto-exposure").onChange(function(value) {
      updateEditable();
      if (value) runAnalysis();
    });

    gui.include_oceans = true;
    gui.add(gui, 'include_oceans').name("include ocean data").onChange(runAnalysis);

    gui.reference_map = false;
    gui.add(gui, 'reference_map').name("reference map").onChange(function(value) {
      if (value) referenceLayer.addTo(map);
      else map.removeLayer(referenceLayer);
    });
    
    exportFolder = gui.addFolder('heightmap export');
    gui.mapSize = 'Gigantomaniac (TF3)';
    gui.ratio = RATIOS[0];
    gui.orientation = 'portrait';
    // Text fields because this dat.gui version rounds number boxes to the precision of their initial value.
    gui.center = '';
    gui.metersPerPixel = String(exportDefaults.metersPerPixel);
    gui.scaleMode = 'height scale';
    gui.heightScale = requestedText;
    gui.steepness = '';
    gui.smoothing = 0;
    gui.oceanFloor = String(GAME_MIN_HEIGHT);
    gui.waterNormalization = false;
    gui.bitDepth = 16;
    exportFolder.add(gui, 'mapSize', Object.keys(MAP_SIZES)).name('map size').onChange(updateExportBox);
    exportFolder.add(gui, 'ratio', RATIOS).name('ratio').onChange(regionChanged);
    exportFolder.add(gui, 'orientation', ['portrait', 'landscape']).name('orientation').onChange(regionChanged);
    onEdit(exportFolder.add(gui, 'center').name('center (lat, lon)'), applyCenter);
    scaleCapHint = addSign(onEdit(exportFolder.add(gui, 'metersPerPixel').name('real m/px'), applyScale), 'info');
    exportFolder.add(gui, 'scaleMode', ['height scale', 'steepness', 'max height']).name('scale by').onChange(function(mode) {
      requestedText = {'height scale': gui.heightScale, 'steepness': gui.steepness, 'max height': gui.maxHeight}[mode];
      updateEditable();
    });
    var heightScaleRow = onEdit(exportFolder.add(gui, 'heightScale').name('height scale'), scaleChanged);
    heightScaleHint = addSign(heightScaleRow, 'info');
    var steepnessRow = onEdit(exportFolder.add(gui, 'steepness').name('steepness (x real)'), scaleChanged);
    steepnessWarning = addSign(steepnessRow, 'warning');
    var smoothingRow = exportFolder.add(gui, 'smoothing', 0, 20).step(0.5).name('smoothing (m)').onFinishChange(runAnalysis);
    // This dat.gui version shows a number to the decimals of its starting value, which would round half meters away.
    smoothingRow.__precision = 2;
    smoothingRow.updateDisplay();
    onEdit(exportFolder.add(gui, 'oceanFloor').name('ocean floor (m)'), runAnalysis);
    var normalizationRow = exportFolder.add(gui, 'waterNormalization').name('water normalization').onChange(runAnalysis);
    normalizationRow.__li.title = [
      'The game has one water level, so rivers and lakes above it come out dry.',
      'This lowers them onto the water level, with the land around them, so they fill along their whole length.',
      'With ocean data on, lowered water will embed into the terrain with a slope that deepens gradually from the shore, up to 10 m.'
    ].join('\n');
    showSign(addSign(normalizationRow, 'experimental'), 'Experimental: Water normalization that keeps rivers and other bodies of water at a singular water level, ' +
      'blending surrounding terrain, to maintain waterways across real world elevation changes.');
    bitDepthHint = addSign(exportFolder.add(gui, 'bitDepth', [16, 8]).name('bit depth').onChange(updateHints), 'info');
    // dat.gui only recognizes plain functions as buttons, not async ones.
    gui.exportHeightmap = function () { exportRegion(); };
    exportFolder.add(gui, 'exportHeightmap').name('export heightmap');
    exportFolder.open();

    var biomeFolder = gui.addFolder('biome export');
    gui.climate = CLIMATES[0];
    climateHint = addSign(biomeFolder.add(gui, 'climate', CLIMATES).name('climate').onChange(function(value) {
      climateFollows = analysis !== null && value == suggestClimate(analysis);
      updateHints();
    }), 'info');
    gui.exportBiomes = function () { exportBiomeMaps(); };
    biomeFolder.add(gui, 'exportBiomes').name('export biomes');
    biomeFolder.open();

    var townFolder = gui.addFolder('town export');
    gui.maxTowns = 65;
    gui.townSpacing = 1200;
    gui.includeVillages = true;
    gui.townNames = 'latin alphabet';
    gui.townSafety = 'nudge';
    townFolder.add(gui, 'maxTowns', 1, 300).step(1).name('max towns');
    townFolder.add(gui, 'townSpacing', 0, 5000).step(50).name('min town spacing (m)');
    townFolder.add(gui, 'includeVillages').name('include villages');
    townNamesHint = addSign(townFolder.add(gui, 'townNames', ['latin alphabet', 'original']).name('town names').onChange(updateHints), 'info');
    townFolder.add(gui, 'townSafety', {'none': 'none', 'skip dangerous': 'skip', 'nudge-skip': 'nudge', 'nudge-force': 'force'}).name('generation safety').__li.title = [
      'The game starts every town with one 88 m street through its position. If that street would be too steep or touch water, the town never grows.',
      'none: picks purely by population. Dangerous towns show in orange.',
      'skip dangerous: skips those and takes others instead.',
      'nudge-skip: moves a dangerous town to the nearest spot within ' + TOWN_NUDGE_REACH + ' m where its street works, without crossing water. A town in water starts from the nearest shore. If there is no such spot, the town is skipped.',
      'nudge-force: takes the nearest spot within ' + TOWN_NUDGE_REACH + ' m where the street works, even across water. If there is none, the town is skipped.',
      'Nudged towns show in blue. Skipped towns show in red.'
    ].join('\n');
    gui.exportTowns = function () { exportTowns(); };
    townFolder.add(gui, 'exportTowns').name('export towns');
    townFolder.open();

    gui.fileName = 'heightmap';
    gui.add(gui, 'fileName').name('file name');
    gui.exportAll = function () { exportAll(); };
    gui.add(gui, 'exportAll').name('export all');

    setUpRemembering();
    gui.help = function () {
      // show help screen and input blocker
      toggleHelp(true);
    }
    gui.add(gui, 'help');
    restoreSettings();
    updateEditable();
    
  }
  // localStorage, or null where the browser blocks it.
  var store = (function() {
    try {
      window.localStorage.getItem(CONSENT_KEY);
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }());

  // Settings are only kept once the visitor agrees. The answer itself is kept either way, so the question isn't asked twice.
  function setUpRemembering() {
    if (!store) return;
    gui.rememberSettings = remembering();
    gui.add(gui, 'rememberSettings').name('remember settings').onChange(setRemembering).__li.title = 'Keeps these panel choices in this browser for your next visit. Nothing is sent anywhere.';
    document.getElementById('consent').hidden = store.getItem(CONSENT_KEY) !== null;
    document.getElementById('consent-yes').onclick = function() { setRemembering(true); };
    document.getElementById('consent-no').onclick = function() { setRemembering(false); };
    // Saving when the page is hidden or closed catches every change without taking over the fields' own handlers.
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState == 'hidden') saveSettings();
    });
    window.addEventListener('pagehide', saveSettings);
  }

  function remembering() {
    return store !== null && store.getItem(CONSENT_KEY) == 'yes';
  }

  function setRemembering(value) {
    store.setItem(CONSENT_KEY, value ? 'yes' : 'no');
    if (value) saveSettings();
    else store.removeItem(SETTINGS_KEY);
    gui.rememberSettings = value;
    controller('rememberSettings').updateDisplay();
    document.getElementById('consent').hidden = true;
  }

  function saveSettings() {
    if (!remembering()) return;
    var saved = {request: requestedText};
    SAVED_SETTINGS.forEach(function(key) { saved[key] = gui[key]; });
    store.setItem(SETTINGS_KEY, JSON.stringify(saved));
  }

  // Skips anything the panel no longer offers, such as an option renamed since the visit that saved it.
  function restoreSettings() {
    if (!remembering()) return;
    var saved;
    try {
      saved = JSON.parse(store.getItem(SETTINGS_KEY)) || {};
    } catch (e) {
      return;
    }
    SAVED_SETTINGS.forEach(function(key) {
      var c = controller(key);
      if (c && key in saved && validSetting(c, saved[key])) gui[key] = saved[key];
    });
    if (typeof saved.request == 'string' && saved.request) {
      requestedText = saved.request;
      // The scale field in use shows the request until the analysis fills in the others.
      gui[{'height scale': 'heightScale', 'steepness': 'steepness', 'max height': 'maxHeight'}[gui.scaleMode]] = requestedText;
    }
    if (gui.reference_map) referenceLayer.addTo(map);
    refreshGUI();
  }

  function validSetting(c, value) {
    if (c.__select) return Array.prototype.some.call(c.__select.options, function(o) { return o.value === String(value); });
    if (typeof c.initialValue == 'number') return typeof value == 'number' && value >= c.__min && value <= c.__max;
    return typeof value == typeof c.initialValue;
  }

  // The export region's size in pixels, north up.
  function outputSize() {
    var km = MAP_SIZES[gui.mapSize][RATIOS.indexOf(gui.ratio)];
    var shortSide = km[0] * 256 + 1, longSide = km[1] * 256 + 1;
    return gui.orientation == 'landscape' ? {width: longSide, height: shortSide} : {width: shortSide, height: longSide};
  }

  // The game always runs a map's long side top to bottom, so landscape exports are turned with north on the left.
  function northLeft() {
    var out = outputSize();
    return out.width > out.height;
  }

  // The exported files' size in pixels.
  function imageSize() {
    var out = outputSize();
    return northLeft() ? {width: out.height, height: out.width} : out;
  }

  // Largest rectangle of the output's aspect ratio that fits the map with a margin, in container pixels.
  // capped: the box would be larger than one copy of the world, so it stops at the world's size instead.
  function exportBoxRect() {
    var size = map.getSize(), out = outputSize();
    var aspect = (out.width - 1) / (out.height - 1);
    var width = size.x * 0.9, height = size.y * 0.9;
    if (width / height > aspect) width = height * aspect;
    else height = width / aspect;
    var world = map.options.crs.scale(map.getZoom()), capped = width > world || height > world;
    if (width > world) {
      width = world;
      height = width / aspect;
    }
    if (height > world) {
      height = world;
      width = height * aspect;
    }
    return {left: (size.x - width) / 2, top: (size.y - height) / 2, width: width, height: height, capped: capped};
  }

  // Projects from the exact center because containerPointToLatLng snaps to Leaflet's whole-pixel origin.
  function exportBounds() {
    var r = exportBoxRect(), zoom = map.getZoom();
    var center = map.project(map.getCenter(), zoom);
    var nw = map.unproject([center.x - r.width / 2, center.y - r.height / 2], zoom);
    var se = map.unproject([center.x + r.width / 2, center.y + r.height / 2], zoom);
    return {west: nw.lng, north: nw.lat, east: se.lng, south: se.lat};
  }

  // World pixels to move the box down by to keep it inside the world, centered when it can't fit.
  function boxOverflow(boxTop, height) {
    var world = map.options.crs.scale(map.getZoom());
    if (height >= world) return (world - height) / 2 - boxTop;
    return Math.min(Math.max(boxTop, 0), world - height) - boxTop;
  }

  // Web Mercator stops at about 85 degrees north and south. There is no terrain past it.
  function keepBoxInWorld() {
    var zoom = map.getZoom(), r = exportBoxRect();
    var center = map.project(map.getCenter(), zoom);
    var shift = boxOverflow(center.y - r.height / 2, r.height);
    // A reset keeps the exact center. Without it Leaflet pans by whole screen pixels.
    if (Math.abs(shift) > 0.01) map.setView(map.unproject([center.x, center.y + shift], zoom), zoom, {reset: true});
  }

  // Leaflet's maxBounds limits the whole view, not a box inside it, so drags are limited here.
  function limitDrag() {
    var r = exportBoxRect();
    this._newPos.y -= boxOverflow(r.top - this._newPos.y + map.getPixelOrigin().y, r.height);
  }

  function metersPerPixel() {
    return heightmapExport.groundWidth(exportBounds()) / (outputSize().width - 1);
  }

  function updateExportBox() {
    var r = exportBoxRect(), out = outputSize(), mpp = metersPerPixel();
    var box = document.getElementById('export-box');
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    var image = imageSize();
    document.getElementById('export-box-size').textContent = image.width + ' x ' + image.height + ' px' +
      (northLeft() ? ' with north on the left' : '') + ', real ' +
      (mpp * (out.width - 1) / 1000).toFixed(2) + ' x ' + (mpp * (out.height - 1) / 1000).toFixed(2) + ' km';

    var center = map.getCenter();
    gui.center = center.lat.toFixed(6) + ', ' + center.lng.toFixed(6);
    gui.metersPerPixel = mpp.toFixed(3);
    // Steepness mode waits for the analysis, which also fits the scale under the game's limit.
    if (gui.scaleMode == 'height scale' && Number(gui.heightScale) > 0) gui.steepness = steepnessText(Number(gui.heightScale), mpp);
    showSteepnessWarning();
    showSign(scaleCapHint, r.capped ? "The map is capped at one copy of the world" : null);
    exportFolder.__controllers.forEach(function(c) { c.updateDisplay(); });
    placeBoxLabel();
  }

  // Keeps the real meters per pixel when the latitude changes.
  function applyCenter() {
    var c = String(gui.center).split(',').map(Number);
    if (c.length != 2 || !(Math.abs(c[0]) < 85) || !(Math.abs(c[1]) <= 180)) {
      showInputError('center must be "lat, lon", e.g. 39.109328, -76.813227');
      return;
    }
    showInputError(null);
    var mpp = metersPerPixel();
    // A reset keeps the exact center. Without it Leaflet pans by whole screen pixels.
    map.setView(c, map.getZoom(), {reset: true});
    zoomToScale(c, mpp);
  }

  // Near a pole the box limit moves the center, which shifts the scale. One zoom step can't settle both.
  function zoomToScale(center, target) {
    var zoom = map.getZoom(), error = Math.log2(metersPerPixel() / target), slope = -1;
    for (var i = 0; i < 20 && Math.abs(error) > 1e-9; i++) {
      map.setView(center, zoom - error / slope, {reset: true});
      var nextZoom = map.getZoom(), nextError = Math.log2(metersPerPixel() / target);
      if (nextZoom != zoom) slope = Math.min(-1, (nextError - error) / (nextZoom - zoom));
      zoom = nextZoom;
      error = nextError;
    }
  }

  function applyScale() {
    var target = Number(gui.metersPerPixel);
    if (!(target > 0)) {
      showInputError('real meters per pixel must be a positive number');
      return;
    }
    showInputError(null);
    zoomToScale(map.getCenter(), target);
  }
  
  function regionChanged() {
    updateExportBox();
    scheduleAnalysis();
  }

  function controllers() {
    return Object.keys(gui.__folders).reduce(function(all, name) { return all.concat(gui.__folders[name].__controllers); }, gui.__controllers);
  }

  function controller(property) {
    return controllers().filter(function(c) { return c.property == property; })[0];
  }

  function refreshGUI() {
    controllers().forEach(function(c) { c.updateDisplay(); });
  }

  function fieldsEditable(properties, editable) {
    properties.forEach(function(property) {
      var input = controller(property).domElement.firstChild;
      if (editable) input.removeAttribute('readonly');
      else input.setAttribute('readonly', true);
    });
  }

  // Auto-exposure fills the in-game heights, except the maximum when it's what "scale by" scales to.
  function updateEditable() {
    fieldsEditable(['maxHeight'], !gui.autoexpose || gui.scaleMode == 'max height');
    fieldsEditable(['minHeight', 'waterLevel'], !gui.autoexpose);
    fieldsEditable(['heightScale'], gui.scaleMode == 'height scale');
    fieldsEditable(['steepness'], gui.scaleMode == 'steepness');
  }

  function heightScale() {
    var k = Number(gui.heightScale);
    if (!(k > 0)) throw new Error('height scale must be a positive number');
    return k;
  }

  // How many times steeper than real the terrain comes out, given the game's 4 m pixels.
  function steepnessText(k, mpp) {
    return String(Number((k * mpp / GAME_METERS_PER_PIXEL).toPrecision(3)));
  }

  // What "scale by" asks for, checked, with the real meters per pixel that steepness depends on.
  function scaleRequest() {
    var value = Number(requestedText);
    if (!(value > 0)) throw new Error(gui.scaleMode + ' must be a positive number');
    if (gui.scaleMode == 'max height' && value > GAME_MAX_HEIGHT) throw new Error('max height cannot be above ' + GAME_MAX_HEIGHT + ', the highest the game accepts');
    return {mode: gui.scaleMode, value: value, mpp: metersPerPixel()};
  }

  // The height scale a request asks for. peak: the real terrain's highest point in meters.
  function scaleFor(request, peak) {
    if (request.mode == 'steepness') return request.value * GAME_METERS_PER_PIXEL / request.mpp;
    if (request.mode == 'max height') {
      if (!(peak > 0)) throw new Error('max height needs land above sea level inside the box');
      return request.value / peak;
    }
    return request.value;
  }

  // The in-game maximum a request pins, or null when the scale decides it.
  function fixedMax(request) {
    return request && request.mode == 'max height' ? request.value : null;
  }

  function requestedScale(peak) {
    return scaleFor(scaleRequest(), peak);
  }

  // Four significant digits, rounded down so a fitted peak stays under the game's limit.
  function scaleDigits(k) {
    var unit = Math.pow(10, Math.floor(Math.log10(k)) - 3);
    return Number((Math.floor(k / unit + 1e-9) * unit).toPrecision(4));
  }

  // lowered: auto-exposure brought k under the requested scale to fit the game's height limit.
  function showScale(k, lowered) {
    gui.heightScale = String(k);
    gui.steepness = steepnessText(k, metersPerPixel());
    showSteepnessWarning();
    showSign(heightScaleHint, lowered ? "Height scale has been modified to keep the max height below the game's limit" : null);
    controller('heightScale').updateDisplay();
    controller('steepness').updateDisplay();
  }

  // dat.gui reports a finished edit whenever a text field loses focus, so the handler only runs when the text changed.
  // Otherwise clicking through a field that shows a fitted value would make that value the request.
  function onEdit(controller, handler) {
    var input = controller.domElement.querySelector('input');
    var before = input.value;
    input.addEventListener('focus', function() {
      before = input.value;
    });
    return controller.onFinishChange(function(value) {
      if (input.value !== before) handler(value);
      before = input.value;
    });
  }

  // A caution or information sign after a field's name, hidden until shown.
  function addSign(row, kind) {
    var name = row.domElement.parentNode.querySelector('.property-name');
    var sign = document.createElement('span');
    sign.className = 'field-sign ' + kind;
    sign.textContent = SIGN_GLYPHS[kind];
    sign.style.display = 'none';
    sign.kind = kind;
    // The name shortens with an ellipsis when it's long, so the sign after it stays visible.
    var text = document.createElement('span');
    text.className = 'field-name';
    text.textContent = name.textContent;
    name.textContent = '';
    name.appendChild(text);
    name.classList.add('has-sign');
    sign.field = text.textContent.replace(/\s*\(.*\)$/, '');
    name.appendChild(sign);
    signs.push(sign);
    return sign;
  }

  // text: the explanation shown on hover, or null to hide the sign.
  function showSign(sign, text) {
    sign.title = text || '';
    sign.style.display = text ? '' : 'none';
    showNotices();
  }

  // The box label's last rows list the fields showing each kind of sign.
  function showNotices() {
    var box = document.getElementById('export-box-notices');
    box.textContent = '';
    ['info', 'warning'].forEach(function(kind) {
      var fields = signs.filter(function(s) { return s.kind == kind && s.style.display != 'none'; }).map(function(s) { return s.field; });
      if (!fields.length) return;
      var line = box.appendChild(document.createElement('div'));
      line.className = kind;
      line.textContent = SIGN_GLYPHS[kind] + ' ' + fields.join(', ');
    });
    placeBoxLabel();
  }

  function showSteepnessWarning() {
    showSign(steepnessWarning, Number(gui.steepness) > STEEPNESS_WARNING ?
      'Steepness values above ' + STEEPNESS_WARNING + ' can look out of place, consider changing your "scale by"' : null);
  }

  // Information signs on fields set away from what the analysis would pick.
  function updateHints() {
    var climate = analysis ? suggestClimate(analysis) : null;
    showSign(climateHint, climate && climate != gui.climate ? 'The suggested climate is ' + climate : null);
    var water = suggestedWaterLevel();
    showSign(waterHint, water !== null && water != Number(gui.waterLevel) ? 'The most common water level in this section is ' + water : null);
    showSign(bitDepthHint, Number(gui.bitDepth) != 16 ? '16 is recommended for game export' : null);
    showSign(townNamesHint, gui.townNames == 'original' ? 'Some names may not display properly in-game' : null);
  }

  // The level auto-exposure would pick, or null when no water body qualifies.
  function suggestedWaterLevel() {
    var k = Number(gui.heightScale);
    if (!analysis || !(k > 0)) return null;
    var choice = autoWaterChoice(waterChoices(analysis.water, k, analysis.floodShare, gui.include_oceans), analysis.areaKm2);
    return choice ? choice.level : null;
  }

  function scaleChanged(value) {
    requestedText = value;
    if (gui.autoexpose) {
      runAnalysis();
      return;
    }
    try {
      showScale(scaleDigits(requestedScale(analysis ? analysis.peak : NaN)));
    } catch (e) {
      showInputError(e.message);
      return;
    }
    applyManualHeights();
  }

  // The lowest in-game height water may reach, or 0 with ocean data off.
  function oceanFloor() {
    if (!gui.include_oceans) return 0;
    var floor = Number(gui.oceanFloor);
    if (!(floor <= 0 && floor >= GAME_MIN_HEIGHT)) throw new Error('ocean floor must be between ' + GAME_MIN_HEIGHT + ' and 0 meters');
    return floor;
  }

  // Lowers the requested scale just enough for the peak to fit under the game's limit.
  function fittedScale(requested, peak) {
    return scaleDigits(requested * peak > GAME_MAX_HEIGHT ? GAME_MAX_HEIGHT / peak : requested);
  }

  // Real-meter clamps from the in-game ocean floor and ceiling, so water keeps its in-game depth at any height scale.
  function limitsFor(k, floor) {
    return {floor: floor / k, ceiling: GAME_MAX_HEIGHT / k, scale: k};
  }

  function heightLimits(peak) {
    var requested = requestedScale(peak);
    var k = gui.autoexpose ? fittedScale(requested, peak) : scaleDigits(requested);
    showScale(k, k < scaleDigits(requested));
    return limitsFor(k, oceanFloor());
  }

  // A flat water surface's in-game level, and the real height at or below which everything becomes water.
  // Carving with ocean data lets the level be the highest whole meter that floods no land. Without it the level has to clear the surface.
  function waterLineFor(surface, k, carved) {
    if (!carved) {
      var level = Math.ceil(k * surface.top + WATER_DEPTH);
      return {level: level, waterline: level / k};
    }
    var waterline = surface.top + SHORE_TOLERANCE;
    return {level: Math.floor(k * waterline), waterline: waterline};
  }

  // Real meters for applyBathymetry: everything at or below the waterline ends WATER_DEPTH under the in-game level.
  function submergeFor(level, waterline, k) {
    return {level: waterline, top: (level - WATER_DEPTH) / k};
  }

  function setBoxWater(text) {
    document.getElementById('export-box-water').textContent = text;
    placeBoxLabel();
  }

  // The label sits above the box, or just inside its top edge when the rows above it would leave the screen.
  function placeBoxLabel() {
    var label = document.getElementById('export-box-label');
    label.classList.remove('inside');
    if (label.offsetHeight > document.getElementById('export-box').offsetTop) label.classList.add('inside');
  }

  // The notice rows describe the last analysis, so they hide while a new one runs.
  function setMeasuring(on) {
    document.getElementById('export-box-label').classList.toggle('measuring', on);
    placeBoxLabel();
  }

  var scheduleAnalysis = debounce(runAnalysis, 300);

  async function runAnalysis() {
    var generation = ++analysisGeneration;
    try {
      var out = outputSize();
      setBoxWater('measuring...');
      setMeasuring(true);
      var result = await heightmapExport.analyze({
        bounds: exportBounds(),
        aspect: (out.width - 1) / (out.height - 1),
        // A superseded run must not change the height scale the newer one measures with.
        limits: function(peak) {
          if (generation != analysisGeneration) throw new Error('superseded');
          return heightLimits(peak);
        },
        submerge: previewSubmerge,
        normalizeWater: gui.waterNormalization ? previewWaterSurface : null,
        smoothing: gui.smoothing / GAME_METERS_PER_PIXEL,
        outputWidth: out.width
      });
    } catch (e) {
      if (generation == analysisGeneration) {
        setBoxWater(e.message);
        setMeasuring(false);
      }
      return;
    }
    if (generation != analysisGeneration) return;
    setMeasuring(false);
    analysis = result;
    var climate = suggestClimate(analysis);
    if (climate && climateFollows && gui.climate != climate) {
      gui.climate = climate;
      controller('climate').updateDisplay();
    }
    if (gui.autoexpose) applyAnalysis();
    else describeWater();
  }

  // The preview takes NOAA depths below the water level the analysis is about to pick, or the typed one.
  function previewSubmerge(water, floodShare, areaKm2) {
    if (!gui.include_oceans) return null;
    var k = heightScale();
    if (!gui.autoexpose) return submergeFor(Number(gui.waterLevel), Number(gui.waterLevel) / k, k);
    var choice = autoWaterChoice(waterChoices(water, k, floodShare, true), areaKm2);
    return choice ? submergeFor(choice.level, choice.waterline, k) : null;
  }

  // Where normalized water ends in the preview: just under the waterline of the level about to be picked, or of the typed one.
  function previewWaterSurface(water, floodShare, areaKm2) {
    var k = heightScale();
    if (!gui.autoexpose) return Number(gui.waterLevel) / k - SHORE_TOLERANCE;
    var choice = autoWaterChoice(waterChoices(water, k, floodShare, gui.include_oceans), areaKm2);
    return choice ? choice.waterline - SHORE_TOLERANCE : null;
  }

  function autoWaterChoice(choices, areaKm2) {
    return choices.filter(function(c) {
      return c.flood <= MAX_FLOOD_SHARE && c.flood * areaKm2 <= MAX_FLOOD_RATIO * c.areaKm2;
    })[0] || null;
  }

  // In-game water levels with their total surface area and the share of the map's dry land each would drown, largest first.
  function waterChoices(water, k, floodShare, carved) {
    var choices = [];
    water.forEach(function(w) {
      var line = waterLineFor(w, k, carved);
      var same = choices.filter(function(c) { return c.level == line.level; })[0];
      if (same) {
        same.areaKm2 += w.areaKm2;
        same.waterline = Math.max(same.waterline, line.waterline);
        same.flood = floodShare(same.waterline);
      } else {
        choices.push({level: line.level, waterline: line.waterline, areaKm2: w.areaKm2, flood: floodShare(line.waterline)});
      }
    });
    return choices.sort(function(a, b) { return b.areaKm2 - a.areaKm2; });
  }

  function describeWater() {
    updateHints();
    try {
      var k = heightScale();
    } catch (e) {
      setBoxWater(e.message);
      return;
    }
    var shown = waterChoices(analysis.water, k, analysis.floodShare, gui.include_oceans).filter(function(c, i) { return i == 0 || c.areaKm2 >= 0.1; });
    var depthNote = analysis.bathymetry && /unavailable/.test(analysis.bathymetry) ? ' (' + analysis.bathymetry + ')' : '';
    if (!shown.length) {
      setBoxWater('no flat water surfaces found' + depthNote);
      return;
    }
    setBoxWater('water levels: ' + shown.slice(0, 4).map(function(c) {
      var flood = c.flood > MAX_FLOOD_SHARE ? ', floods ' + Math.round(c.flood * 100) + '% of the map' : '';
      return c.level + ' (' + c.areaKm2.toFixed(1) + ' km2' + flood + ')';
    }).join(', ') + depthNote);
  }

  // A rule of thumb from latitude and natural land cover. No data, water, built area and cloud (Impact Observatory 0, 1, 7, 10) are left out.
  function suggestClimate(a) {
    if (!a.landCover) return null;
    var c = a.landCover;
    var natural = 1 - (c[0] || 0) - (c[1] || 0) - (c[7] || 0) - (c[10] || 0);
    if (natural < 0.05) return null;
    var trees = (c[2] || 0) / natural, crops = (c[5] || 0) / natural;
    var dryland = ((c[8] || 0) + (c[11] || 0)) / natural;
    var lat = Math.abs(a.centerLat);
    if (lat >= 58 || (lat >= 50 && trees > 0.5 && crops < 0.1)) return 'Subarctic';
    if (dryland > 0.6 && trees < 0.15) return 'Dry';
    if (lat < 23.5) return 'Tropical';
    return 'Temperate';
  }

  function applyAnalysis() {
    try {
      var k = heightScale();
    } catch (e) {
      showInputError(e.message);
      return;
    }
    var h = heightsFor(analysis, k, gui.include_oceans, fixedMax(scaleRequest()));
    gui.minHeight = String(h.min);
    gui.maxHeight = String(h.max);
    gui.waterLevel = String(h.water);
    describeWater();
    refreshGUI();
    updateDisplayRange();
  }

  // In-game minimum, maximum and water level for an analysis at height scale k.
  // max: the in-game maximum to keep, or null to measure it.
  function heightsFor(a, k, carved, max) {
    var min = Math.max(GAME_MIN_HEIGHT, Math.floor(k * a.min));
    max = Math.min(GAME_MAX_HEIGHT, Math.max(min + 1, max || Math.ceil(k * a.max)));
    var choice = autoWaterChoice(waterChoices(a.water, k, a.floodShare, carved), a.areaKm2);
    return {k: k, min: min, max: max, water: choice ? choice.level : Math.max(GAME_MIN_HEIGHT, min - 1), waterline: choice ? choice.waterline : -Infinity};
  }

  function readHeights() {
    var k = heightScale();
    var min = Number(gui.minHeight), max = Number(gui.maxHeight), water = Number(gui.waterLevel);
    if (!isFinite(min) || !isFinite(max) || !(max > min)) throw new Error('maximum height must be above minimum height');
    if (min < GAME_MIN_HEIGHT) throw new Error('minimum height cannot be below ' + GAME_MIN_HEIGHT + ', the lowest the game accepts');
    if (max > GAME_MAX_HEIGHT) throw new Error('maximum height cannot be above ' + GAME_MAX_HEIGHT + ', the highest the game accepts');
    if (!isFinite(water)) throw new Error('water level must be a number');
    return {k: k, min: min, max: max, water: water};
  }

  function applyManualHeights() {
    try {
      readHeights();
    } catch (e) {
      showInputError(e.message);
      return;
    }
    showInputError(null);
    if (analysis) describeWater();
    updateDisplayRange();
  }

  // The map shades real elevations, so the in-game range is divided back by the height scale.
  function updateDisplayRange() {
    var h = readHeights();
    var uniforms = scene.styles.hillshade.shaders.uniforms;
    uniforms.u_min = h.min / h.k;
    uniforms.u_max = h.max / h.k;
    scene.requestRedraw();
  }

  function showInputError(message) {
    document.getElementById('status-message').textContent = message || '';
  }

  var tasks = [];
  var tasksRunning = false;

  // Snapshots the settings when an export is queued, so panning or editing afterwards doesn't change what it writes.
  // run(job, report) resolves to the summary lines shown once the task finishes.
  function queueTask(label, run, needsHeights) {
    var job;
    try {
      job = exportJob(needsHeights);
    } catch (e) {
      showInputError(e.message);
      return;
    }
    showInputError(null);
    tasks.push({label: label + ': ' + job.name + ', ' + job.mapName, job: job, run: run, state: 'queued', stage: '', fraction: null, lines: [], open: true});
    renderTasks();
    var panel = document.getElementById('status');
    panel.scrollTop = panel.scrollHeight;
    runTasks();
  }

  async function runTasks() {
    if (tasksRunning) return;
    tasksRunning = true;
    var task;
    while ((task = tasks.filter(function(t) { return t.state == 'queued'; })[0])) {
      task.state = 'running';
      renderTasks();
      try {
        task.lines = await task.run(task.job, reporter(task));
        task.state = 'done';
      } catch (e) {
        task.lines = [e.message];
        task.state = 'failed';
        console.error(e);
      }
      // Only the newest result stays expanded.
      tasks.forEach(function(t) { if (t !== task && t.state != 'queued') t.open = false; });
      renderTasks();
    }
    tasksRunning = false;
  }

  // report(stage, fraction): fraction runs 0 to 1, or is left out when the step has no measurable progress.
  function reporter(task) {
    return function(stage, fraction) {
      task.stage = stage;
      task.fraction = fraction === undefined ? null : fraction;
      showProgress(task);
    };
  }

  function renderTasks() {
    var list = document.getElementById('tasks');
    list.textContent = '';
    tasks.forEach(function(t) {
      var item = element('div', 'task ' + t.state);
      var head = element('div', 'task-head');
      var label = element('span', 'task-label', t.label);
      label.onclick = function() {
        t.open = !t.open;
        renderTasks();
      };
      head.appendChild(label);
      t.view = {state: head.appendChild(element('span', 'task-state'))};
      if (t.state != 'running') {
        var close = head.appendChild(element('button', 'task-close', 'x'));
        close.title = t.state == 'queued' ? 'Cancel' : 'Dismiss';
        close.onclick = function() {
          tasks.splice(tasks.indexOf(t), 1);
          renderTasks();
        };
      }
      item.appendChild(head);
      if (t.state == 'running') {
        t.view.bar = item.appendChild(element('div', 'task-bar'));
        t.view.fill = t.view.bar.appendChild(element('div', 'task-fill'));
        t.view.text = item.appendChild(element('div', 'task-text'));
      } else if (t.open && t.lines.length) {
        item.appendChild(element('div', 'task-text', t.lines.join('\n')));
      }
      list.appendChild(item);
      showProgress(t);
    });
  }

  // Updates a task's card in place, since rebuilding the list on every tile would swallow clicks on it.
  function showProgress(t) {
    if (!t.view) return;
    if (t.state == 'queued') {
      var ahead = tasks.slice(0, tasks.indexOf(t)).filter(function(o) { return o.state == 'queued' || o.state == 'running'; }).length;
      t.view.state.textContent = 'queued' + (ahead ? ', ' + ahead + ' ahead' : '');
    } else if (t.state == 'running') {
      t.view.state.textContent = t.fraction === null ? 'running' : Math.round(t.fraction * 100) + '%';
      t.view.bar.className = 'task-bar' + (t.fraction === null ? ' busy' : '');
      t.view.fill.style.width = t.fraction === null ? '' : (t.fraction * 100).toFixed(1) + '%';
      t.view.text.textContent = t.stage;
    } else {
      t.view.state.textContent = t.state;
    }
  }

  function element(tag, className, text) {
    var e = document.createElement(tag);
    e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Everything an export reads, taken when it's queued.
  function exportJob(needsHeights) {
    var out = outputSize();
    return {
      bounds: exportBounds(), out: out, northLeft: northLeft(), image: imageSize(), mpp: metersPerPixel(),
      name: exportName(), mapName: mapName(), climate: gui.climate, bitDepth: Number(gui.bitDepth), smoothing: gui.smoothing,
      auto: gui.autoexpose, oceans: gui.include_oceans, oceanFloor: needsHeights ? oceanFloor() : 0, waterNormalization: gui.waterNormalization,
      request: needsHeights ? scaleRequest() : null, heights: needsHeights ? readHeights() : null, analysis: analysis,
      towns: {maxTowns: Math.round(gui.maxTowns), minSpacing: Number(gui.townSpacing), includeVillages: gui.includeVillages, originalNames: gui.townNames == 'original', safety: gui.townSafety},
      view: viewKey()
    };
  }

  // Changes whenever the live fields would stop describing an export queued now.
  function viewKey() {
    return JSON.stringify([exportBounds(), outputSize(), gui.scaleMode, requestedText, gui.autoexpose, gui.include_oceans, gui.oceanFloor, gui.smoothing, gui.waterNormalization]);
  }

  function exportName() {
    return gui.fileName || 'heightmap';
  }

  function mapName() {
    return gui.mapSize + ' ' + gui.ratio + ' ' + gui.orientation;
  }

  async function buildHeightmap(job, report) {
    // The fields only hold the in-game water level, so auto mode takes the waterline from the analysis.
    var h = job.auto && job.analysis ? heightsFor(job.analysis, job.heights.k, job.oceans, fixedMax(job.request)) :
      Object.assign({waterline: job.heights.water / job.heights.k}, job.heights);
    var meta = {heightScale: h.k, waterLevel: h.water, smoothing: job.smoothing};
    var rivers = job.waterNormalization ? await riverLines(job, report) : {lines: null, note: null};
    // A water level under the minimum means the map has no water, so nothing is carved and the level follows the final minimum.
    var dry = h.water < h.min;
    var lowered = false;
    report('Fetching elevation tiles...', 0);
    var result = await heightmapExport.render({
      bounds: job.bounds,
      width: job.out.width,
      height: job.out.height,
      bitDepth: job.bitDepth,
      // Full resolution can find a higher peak than the preview, which moves the auto scale and the water level with it.
      limits: function(peak) {
        var requested = scaleFor(job.request, peak);
        var k = job.auto ? fittedScale(requested, peak) : h.k;
        lowered = job.auto && k < scaleDigits(requested);
        if (k != h.k && job.analysis) {
          h = heightsFor(job.analysis, k, job.oceans, fixedMax(job.request));
          Object.assign(meta, {heightScale: h.k, waterLevel: h.water});
        }
        // Normalized water ends just under the waterline, so the export takes it as water.
        return Object.assign(limitsFor(h.k, job.oceanFloor), {waterSurface: h.water < h.min ? NaN : h.waterline - SHORE_TOLERANCE});
      },
      // Auto mode widens to whole in-game meters if full resolution finds a higher peak or lower point than the preview.
      range: function(lo, hi) {
        if (job.auto) {
          var noWater = h.water < h.min;
          h.min = Math.max(GAME_MIN_HEIGHT, Math.min(h.min, Math.floor(h.k * lo)));
          h.max = Math.min(GAME_MAX_HEIGHT, Math.max(h.max, Math.ceil(h.k * hi)));
          if (noWater) h.water = meta.waterLevel = Math.max(GAME_MIN_HEIGHT, h.min - 1);
        }
        return {min: h.min / h.k, max: h.max / h.k};
      },
      submerge: job.oceans && !dry ? submergeFor(h.water, h.waterline, h.k) : null,
      smoothing: job.smoothing / GAME_METERS_PER_PIXEL,
      waterLevel: dry ? -Infinity : h.waterline,
      normalizeWater: job.waterNormalization,
      rivers: rivers.lines,
      northLeft: job.northLeft,
      meta: meta,
      onProgress: function(fraction) {
        report('Fetching elevation tiles...', fraction);
      },
      onStage: report
    });
    // The fields show the final values, as long as they still describe this export.
    if (job.auto && viewKey() == job.view) {
      showScale(h.k, lowered);
      gui.minHeight = String(h.min);
      gui.maxHeight = String(h.max);
      gui.waterLevel = String(h.water);
      refreshGUI();
      updateDisplayRange();
      updateHints();
    }
    console.log('heightmap export', result.meta);
    return {blob: result.blob, meta: result.meta, heights: h, terrain: result.terrain, rivers: rivers.note};
  }

  function normalizationNote(n, rivers) {
    if (!n) return '';
    if (typeof n == 'string') return ', water normalization ' + n;
    return ', ' + n.lowered + ' water bodies lowered up to ' + Math.round(n.deepest) + ' in-game m' + (n.dryKm2 >= 0.05 ? ', ' + n.dryKm2.toFixed(1) + ' km2 left dry over 100 m up' : '') +
      (rivers ? ', ' + rivers : '');
  }

  // OpenStreetMap river courses for water normalization, since land cover can't see narrow rivers. The export goes on without them if the lookup fails.
  async function riverLines(job, report) {
    report('Looking up rivers...');
    try {
      var lines = await overpass.rivers(job.bounds, RIVER_MIN_LENGTH * job.mpp / GAME_METERS_PER_PIXEL);
      return {lines: lines, note: lines.length + ' OpenStreetMap river lines'};
    } catch (e) {
      return {lines: null, note: 'river lines unavailable (' + e.message + ')'};
    }
  }

  function heightmapSummary(r, job) {
    var m = r.meta, h = r.heights;
    return [
      'Transport Fever import: Minimum Height ' + h.min + ', Maximum Height ' + h.max + ', Water Level ' + h.water,
      'height scale ' + h.k + ', ' + steepnessText(h.k, job.mpp) + 'x real steepness, real elevations ' + m.blackMeters.toFixed(2) + ' to ' + m.whiteMeters.toFixed(2) + ' m',
      'water depth: ' + (m.bathymetry || (job.oceans ? 'no water on the map' : 'ocean data off, below sea level clamped to 0 m')) +
        (job.smoothing ? ', land smoothed over ' + job.smoothing + ' in-game m' : '') + normalizationNote(m.waterNormalization, r.rivers),
      m.cappedFraction > 0 ? (m.cappedFraction * 100).toFixed(2) + '% of the map was above the game\'s ' + GAME_MAX_HEIGHT + ' m limit and was flattened. Lower the height scale to keep those peaks.' : null,
      'real ' + (job.mpp * (job.out.width - 1) / 1000).toFixed(2) + ' x ' + (job.mpp * (job.out.height - 1) / 1000).toFixed(2) + ' km at ' + m.metersPerPixel.toFixed(3) + ' m/px',
      'center ' + m.centerLat.toFixed(6) + ', ' + m.centerLng.toFixed(6),
      'bounds W ' + m.west.toFixed(6) + ' S ' + m.south.toFixed(6) + ' E ' + m.east.toFixed(6) + ' N ' + m.north.toFixed(6),
      'source zoom ' + m.sourceZoom + (m.upsampled ? ' (output is finer than the source data, upsampled)' : '')
    ].filter(function(line) { return line !== null; });
  }

  // h: the in-game heights the water level comes from, when they differ from the job's.
  // lenient: an OpenStreetMap outage leaves the volcano mask empty instead of failing.
  async function buildBiomes(job, report, h, lenient) {
    h = h || job.heights;
    var volcanoes = [], volcanoError = null;
    if (job.climate == 'Tropical') {
      report('Looking up volcanoes...');
      try {
        volcanoes = await overpass.nodes(job.bounds, '["natural"="volcano"]');
      } catch (e) {
        if (!lenient) throw e;
        volcanoError = e.message;
      }
    }
    var result = await heightmapExport.renderBiomes({
      bounds: job.bounds,
      width: job.out.width,
      height: job.out.height,
      climate: job.climate,
      waterLevel: h.water / h.k,
      volcanoes: volcanoes,
      northLeft: job.northLeft,
      onStage: report
    });
    result.volcanoCount = volcanoes.length;
    result.volcanoError = volcanoError;
    return result;
  }

  function biomeSummary(result) {
    return [
      'biomes 0-4: ' + result.biomeShares.map(function(v) { return (v * 100).toFixed(1) + '%'; }).join(', '),
      result.layers.map(function(l) {
        var source = l.key != 'volcano' ? '' : result.volcanoError ? ', left empty because ' + result.volcanoError :
          ' from ' + result.volcanoCount + ' OpenStreetMap volcanoes';
        return l.key + ' ' + (l.share * 100).toFixed(1) + '%' + source;
      }).join(', ')
    ];
  }

  function biomeFiles(result, name) {
    return [{path: name + '_biomes.png', blob: result.biomes}].concat(result.layers.map(function(l) {
      return {path: name + '_' + l.key + '.png', blob: l.blob};
    }));
  }

  // h: the in-game heights the water comes from, when they differ from the job's.
  // terrain: the heightmap's own heights. Without it, each town site check fetches its own tiles.
  async function buildTowns(job, report, h, terrain) {
    var levels = townLevels(job, h);
    // Fetched town sites need the same lowering the heightmap gets, planned once for the whole map.
    var plan = null;
    if (job.waterNormalization && !terrain && isFinite(levels.waterline)) {
      var rivers = await riverLines(job, report);
      plan = await heightmapExport.planWater(job.bounds, job.out.width, job.out.height, levels.k, levels.waterline - SHORE_TOLERANCE, report, rivers.lines);
    }
    var safety = job.towns.safety;
    var reach = safety == 'nudge' || safety == 'force' ? TOWN_NUDGE_REACH : 0;
    var result = await townExport.build(Object.assign({
      bounds: job.bounds,
      width: job.out.width,
      height: job.out.height,
      northLeft: job.northLeft,
      onStage: report,
      reach: reach,
      overLand: safety == 'nudge',
      keepUnsafe: safety == 'none',
      waterline: levels.waterline,
      heightScale: levels.k,
      terrainPatch: function(px, py, radius) {
        return heightmapExport.terrainPatch(job.bounds, job.out.width, job.out.height, px, py, radius,
          {terrain: terrain, smoothing: job.smoothing / GAME_METERS_PER_PIXEL, level: levels.waterline, plan: plan});
      }
    }, job.towns));
    // Yellow: should grow. Orange: exported but may never grow. Blue: moved so it should grow. Red: skipped.
    townLayer.clearLayers().addTo(map);
    result.towns.forEach(function(t) {
      var color = t.from ? '#3399ff' : t.problems.length ? '#ff8c00' : '#ffcc00';
      if (t.from) L.polyline([[t.from.lat, t.from.lng], [t.lat, t.lng]], {color: color, weight: 1, dashArray: '3 3'}).addTo(townLayer);
      L.circleMarker([t.lat, t.lng], {radius: 4, color: color, weight: 2, fillOpacity: 0.8})
        .bindTooltip(t.name + ', size ' + t.size + (t.from ? ', moved ' + Math.round(t.moved) + ' m because its first street was ' + streetProblems(t) :
          t.problems.length ? ', may never grow, first street ' + streetProblems(t) : ''))
        .addTo(townLayer);
    });
    result.skipped.forEach(function(t) {
      L.circleMarker([t.lat, t.lng], {radius: 4, color: '#ff3030', weight: 2, fillOpacity: 0.8})
        .bindTooltip(t.name + ', skipped, ' + (reach ? 'no working spot within ' + reach + ' m' : 'first street ' + streetProblems(t)))
        .addTo(townLayer);
    });
    return result;
  }

  function streetProblems(town) {
    return town.problems.join(' and ');
  }

  function townSummary(result, job) {
    var names = result.towns.map(function(t) { return t.name; });
    var lines = [
      result.towns.length + ' towns, chosen from ' + result.candidates + ' places inside the map',
      names.slice(0, 10).join(', ') + (names.length > 10 ? ', ...' : '')
    ];
    var list = function(towns, label) {
      return towns.slice(0, 10).map(label).join(', ') + (towns.length > 10 ? ', ...' : '');
    };
    var withProblems = function(t) { return t.name + ' (' + streetProblems(t) + ')'; };
    var nudged = result.towns.filter(function(t) { return t.from; });
    var risky = result.towns.filter(function(t) { return t.problems.length && !t.from; });
    if (nudged.length) lines.push('nudged: ' + list(nudged, function(t) { return t.name + ' ' + Math.round(t.moved) + ' m'; }));
    if (result.skipped.length) {
      var nudging = job.towns.safety == 'nudge' || job.towns.safety == 'force';
      lines.push((nudging ? 'skipped, no working spot within ' + TOWN_NUDGE_REACH + ' m: ' : 'skipped, first street fails: ') + list(result.skipped, withProblems));
    }
    if (risky.length) lines.push('may never grow, first street fails: ' + list(risky, withProblems));
    if (result.note) lines.push(result.note);
    return lines;
  }

  // The height scale, and the real meters at or below which the export makes water. Auto mode takes them from the analysis, since the fields only hold the in-game level.
  function townLevels(job, h) {
    h = h || (job.auto && job.analysis ? heightsFor(job.analysis, job.heights.k, job.oceans, fixedMax(job.request)) : job.heights);
    return {k: h.k, waterline: h.waterline !== undefined ? h.waterline : h.water / h.k};
  }

  function exportRegion() {
    queueTask('Heightmap', async function(job, report) {
      var r = await buildHeightmap(job, report);
      saveAs(r.blob, job.name + '.png');
      return ['Saved ' + job.name + '.png, ' + r.meta.width + 'x' + r.meta.height + ' ' + r.meta.bitDepth + '-bit grayscale']
        .concat(heightmapSummary(r, job));
    }, true);
  }

  function exportBiomeMaps() {
    queueTask('Biomes', async function(job, report) {
      var result = await buildBiomes(job, report);
      var files = biomeFiles(result, job.name);
      files.forEach(function(f) { saveAs(f.blob, f.path); });
      return ['Saved ' + files.map(function(f) { return f.path; }).join(', ') + ', ' + job.image.width + 'x' + job.image.height + ', ' + job.climate]
        .concat(biomeSummary(result), ['Put them in the game\'s biomes folder and import them after the heightmap.']);
    }, true);
  }

  function exportTowns() {
    queueTask('Towns', async function(job, report) {
      var result = await buildTowns(job, report);
      saveAs(new Blob([result.lua], {type: 'text/plain'}), job.name + '_towns.lua');
      var lines = townSummary(result, job);
      lines[0] = 'Saved ' + lines[0];
      return lines;
    }, true);
  }

  // Laid out like the game's user data folder, so extracting it there puts every file where its import dialog looks.
  function exportAll() {
    queueTask('Export all', async function(job, report) {
      function step(n, name) {
        return function(stage, fraction) {
          report(n + '/3 ' + name + ': ' + stage, fraction);
        };
      }
      var heightmap = await buildHeightmap(job, step(1, 'heightmap'));
      // An OpenStreetMap outage shouldn't sink the whole export, so the zip goes out without towns and its name says so.
      var towns = null, townError = null;
      try {
        towns = await buildTowns(job, step(2, 'towns'), heightmap.heights, heightmap.terrain);
      } catch (e) {
        townError = e.message;
      }
      // Towns go before biomes so the full-size terrain is freed before biomes builds its own.
      heightmap.terrain = null;
      var biomes = await buildBiomes(job, step(3, 'biomes'), heightmap.heights, true);
      var zipName = job.name + (towns ? '' : '_NO_TOWNS') + '.zip';
      report('Writing ' + zipName + '...', 0);
      var files = [{path: 'heightmaps/' + job.name + '.png', blob: heightmap.blob}].concat(biomeFiles(biomes, job.name).map(function(f) {
        return {path: 'biomes/' + f.path, blob: f.blob};
      }));
      if (towns) files.push({path: 'towns_industries/' + job.name + '.lua', blob: new Blob([towns.lua], {type: 'text/plain'})});
      saveAs(await heightmapExport.zip(files, function(f) { report('Writing ' + zipName + '...', f); }), zipName);
      return ['Saved ' + zipName + ' for ' + job.climate + '. Extract it into the Transport Fever 3 user folder, %APPDATA%\\Transport Fever 3.']
        .concat(heightmapSummary(heightmap, job).slice(0, 4), biomeSummary(biomes), towns ? townSummary(towns, job) : ['towns left out because ' + townError]);
    }, true);
  }

  // show and hide help screen
  function toggleHelp(active) {
    var visibility = active ? "visible" : "hidden";
    document.getElementById('help').style.visibility = visibility;
    // help-blocker prevents map interaction while help is visible
    document.getElementById('help-blocker').style.visibility = visibility;
  }
  
  // show and hide new alert
  function toggleNew(active) {
    var visibility = active ? "visible" : "hidden";
    document.getElementById('new').style.visibility = visibility;
    // help-blocker prevents map interaction while help is visible
    document.getElementById('help-blocker').style.visibility = visibility;
  }
  
  document.onkeydown = function (e) {
    e = e || window.event;
    // listen for 'h'
    if (e.which == 72 && document.activeElement.tagName != 'INPUT') {
      // toggle UI
      var display = map._controlContainer.style.display;
      map._controlContainer.style.display = (display === "none") ? "block" : "none";
      document.getElementsByClassName('dg')[0].style.display = (display === "none") ? "block" : "none";
      // listen for 'esc'
    } else if (e.which == 27) {
      toggleHelp(false);
    }
  };
  
  /***** Render loop *****/
  window.addEventListener('load', function () {
    // Scene initialized
    layer.on('init', function() {
      gui = new dat.GUI({ autoPlace: true, hideable: true, width: 320 });
      addGUI();
      // resetViewComplete();
      scene.subscribe({
        // will be triggered when tiles are finished loading
        // and also manually by the moveend event
        view_complete: function() {
        }
      });

      if (startAtDefaults) applyScale();
      keepBoxInWorld();
      updateExportBox();
      map.on('moveend', keepBoxInWorld);
      map.dragging._draggable.on('predrag', limitDrag);
      map.on('move zoom resize', updateExportBox);
      map.on('moveend zoomend resize', scheduleAnalysis);
      runAnalysis();
    });
    layer.addTo(map);
    
    // bind help div onclicks
    document.getElementById('help').onclick = function(){toggleHelp(false)};
    document.getElementById('new').onclick = function(){toggleNew(false)};
    document.getElementById('help-blocker').onclick = function(){toggleHelp(false);toggleNew(false);};
    
    // debounce moveend event
    var moveend = debounce(function(e) {
      moving = false;
      // manually reset view_complete
      scene.resetViewComplete();
      scene.requestRedraw();
    }, 250);
    
    map.on("movestart", function (e) { moving = true; });
    map.on("moveend", function (e) { moveend(e) });
    
    // toggleNew(true);
  });
  
  return map;
  
}());

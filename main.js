/*jslint browser: true*/
/*global Tangram, gui */

map = (function () {
  'use strict';
  
  var map_start_location = [0, 0, 2];
  var moving = false;
  var exporting = false;
  var analysis = null;
  var analysisGeneration = 0;
  var exportFolder;
  var inputError = false;
  const exportDefaults = {lat: 39.109328, lng: -76.813227, metersPerPixel: 10};
  const RATIOS = ['1:1', '1:2', '1:3', '1:4', '1:5'];
  const CLIMATES = ['Temperate', 'Dry', 'Tropical', 'Subarctic'];
  // Lowest Minimum Height and highest Maximum Height the game's import dialog accepts.
  const GAME_MIN_HEIGHT = -100;
  const GAME_MAX_HEIGHT = 3177;
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
    gui.add(gui, 'maxHeight').name('maximum height').onFinishChange(applyManualHeights);
    gui.add(gui, 'minHeight').name('minimum height').onFinishChange(applyManualHeights);
    gui.add(gui, 'waterLevel').name('water level').onFinishChange(applyManualHeights);

    gui.scaleFactor = 1 +'';
    gui.add(gui, 'scaleFactor').name("z:x scale factor");

    gui.autoexpose = true;
    gui.add(gui, 'autoexpose').name("auto-exposure").onChange(function(value) {
      heightFieldsEditable(!value);
      if (value) runAnalysis();
    });

    gui.include_oceans = true;
    gui.add(gui, 'include_oceans').name("include ocean data").onChange(runAnalysis);

    gui.export = function () {
      return scene.screenshot().then(function(screenshot) {
        // uses FileSaver.js: https://github.com/eligrey/FileSaver.js/
        saveAs(screenshot.blob, 'heightmapper-' + (+new Date()) + '.png');
      });
    }
    gui.add(gui, 'export').name("screenshot (8-bit view)");

    gui.reference_map = false;
    gui.add(gui, 'reference_map').name("reference map").onChange(function(value) {
      if (value) referenceLayer.addTo(map);
      else map.removeLayer(referenceLayer);
    });
    
    exportFolder = gui.addFolder('heightmap export');
    gui.mapSize = 'Gigantomaniac (TF3)';
    gui.climate = CLIMATES[0];
    gui.ratio = RATIOS[0];
    gui.orientation = 'portrait';
    // Text fields because this dat.gui version rounds number boxes to the precision of their initial value.
    gui.center = '';
    gui.metersPerPixel = String(exportDefaults.metersPerPixel);
    gui.heightScale = '1';
    gui.oceanFloor = String(GAME_MIN_HEIGHT);
    gui.bitDepth = 16;
    gui.fileName = 'heightmap';
    exportFolder.add(gui, 'mapSize', Object.keys(MAP_SIZES)).name('map size').onChange(updateExportBox);
    exportFolder.add(gui, 'climate', CLIMATES).name('climate');
    exportFolder.add(gui, 'ratio', RATIOS).name('ratio').onChange(regionChanged);
    exportFolder.add(gui, 'orientation', ['portrait', 'landscape']).name('orientation').onChange(regionChanged);
    exportFolder.add(gui, 'center').name('center (lat, lon)').onFinishChange(applyCenter);
    exportFolder.add(gui, 'metersPerPixel').name('real meters per pixel').onFinishChange(applyScale);
    exportFolder.add(gui, 'heightScale').name('height scale').onFinishChange(function() {
      if (gui.autoexpose) runAnalysis();
      else applyManualHeights();
    });
    exportFolder.add(gui, 'oceanFloor').name('ocean floor (m)').onFinishChange(runAnalysis);
    exportFolder.add(gui, 'bitDepth', [16, 8]).name('bit depth');
    exportFolder.add(gui, 'fileName').name('file name');
    // dat.gui only recognizes plain functions as buttons, not async ones.
    gui.exportHeightmap = function () { exportRegion(); };
    exportFolder.add(gui, 'exportHeightmap').name('export heightmap');
    exportFolder.open();

    var biomeFolder = gui.addFolder('biome export');
    gui.exportBiomes = function () { exportBiomeMaps(); };
    biomeFolder.add(gui, 'exportBiomes').name('export biomes');
    biomeFolder.open();

    var townFolder = gui.addFolder('town export');
    gui.maxTowns = 65;
    gui.townSpacing = 1200;
    gui.includeVillages = true;
    townFolder.add(gui, 'maxTowns', 1, 300).step(1).name('max towns');
    townFolder.add(gui, 'townSpacing', 0, 5000).step(50).name('min town spacing (m)');
    townFolder.add(gui, 'includeVillages').name('include villages');
    gui.exportTowns = function () { exportTowns(); };
    townFolder.add(gui, 'exportTowns').name('export towns');
    townFolder.open();

    gui.exportAll = function () { exportAll(); };
    gui.add(gui, 'exportAll').name('export all');

    gui.help = function () {
      // show help screen and input blocker
      toggleHelp(true);
    }
    gui.add(gui, 'help');
    // set scale factor text field to be uneditable but still selectable (for copying)
    controller('scaleFactor').domElement.firstChild.setAttribute("readonly", true);
    
  }
  function outputSize() {
    var km = MAP_SIZES[gui.mapSize][RATIOS.indexOf(gui.ratio)];
    var shortSide = km[0] * 256 + 1, longSide = km[1] * 256 + 1;
    return gui.orientation == 'landscape' ? {width: longSide, height: shortSide} : {width: shortSide, height: longSide};
  }

  // Largest rectangle of the output's aspect ratio that fits the map with a margin, in container pixels.
  function exportBoxRect() {
    var size = map.getSize(), out = outputSize();
    var aspect = (out.width - 1) / (out.height - 1);
    var width = size.x * 0.9, height = size.y * 0.9;
    if (width / height > aspect) width = height * aspect;
    else height = width / aspect;
    return {left: (size.x - width) / 2, top: (size.y - height) / 2, width: width, height: height};
  }

  // Projects from the exact center because containerPointToLatLng snaps to Leaflet's whole-pixel origin.
  function exportBounds() {
    var r = exportBoxRect(), zoom = map.getZoom();
    var center = map.project(map.getCenter(), zoom);
    var nw = map.unproject([center.x - r.width / 2, center.y - r.height / 2], zoom);
    var se = map.unproject([center.x + r.width / 2, center.y + r.height / 2], zoom);
    return {west: nw.lng, north: nw.lat, east: se.lng, south: se.lat};
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
    document.getElementById('export-box-size').textContent = out.width + ' x ' + out.height + ' px, real ' +
      (mpp * (out.width - 1) / 1000).toFixed(2) + ' x ' + (mpp * (out.height - 1) / 1000).toFixed(2) + ' km';

    var center = map.getCenter();
    gui.center = center.lat.toFixed(6) + ', ' + center.lng.toFixed(6);
    gui.metersPerPixel = mpp.toFixed(3);
    exportFolder.__controllers.forEach(function(c) { c.updateDisplay(); });
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
    map.setView(c, map.getZoom() + Math.log2(metersPerPixel() / mpp), {reset: true});
  }

  function applyScale() {
    var target = Number(gui.metersPerPixel);
    if (!(target > 0)) {
      showInputError('real meters per pixel must be a positive number');
      return;
    }
    showInputError(null);
    map.setView(map.getCenter(), map.getZoom() + Math.log2(metersPerPixel() / target), {reset: true});
  }
  
  function regionChanged() {
    updateExportBox();
    scheduleAnalysis();
  }

  function controller(property) {
    return gui.__controllers.filter(function(c) { return c.property == property; })[0];
  }

  function refreshGUI() {
    gui.__controllers.concat(exportFolder.__controllers).forEach(function(c) { c.updateDisplay(); });
  }

  function heightFieldsEditable(editable) {
    ['maxHeight', 'minHeight', 'waterLevel'].forEach(function(property) {
      var input = controller(property).domElement.firstChild;
      if (editable) input.removeAttribute('readonly');
      else input.setAttribute('readonly', true);
    });
  }

  function heightScale() {
    var k = Number(gui.heightScale);
    if (!(k > 0)) throw new Error('height scale must be a positive number');
    return k;
  }

  // Real-meter clamp, tightened so the in-game minimum stays within the game's limit at any height scale.
  function heightFloor() {
    if (!gui.include_oceans) return 0;
    var floor = Number(gui.oceanFloor);
    if (!(floor <= 0 && floor >= GAME_MIN_HEIGHT)) throw new Error('ocean floor must be between ' + GAME_MIN_HEIGHT + ' and 0 meters');
    return Math.max(floor, GAME_MIN_HEIGHT / heightScale());
  }

  function heightCeiling() {
    return GAME_MAX_HEIGHT / heightScale();
  }

  // In-game level that puts a flat water surface just under water.
  function waterLevelFor(surface, k) {
    return Math.ceil(k * surface.top + 0.5);
  }

  function setBoxWater(text) {
    document.getElementById('export-box-water').textContent = text;
  }

  var scheduleAnalysis = debounce(runAnalysis, 300);

  async function runAnalysis() {
    var generation = ++analysisGeneration;
    try {
      var floor = heightFloor();
      var out = outputSize();
      setBoxWater('measuring...');
      var result = await heightmapExport.analyze({
        bounds: exportBounds(),
        aspect: (out.width - 1) / (out.height - 1),
        floor: floor,
        ceiling: heightCeiling(),
        bathymetryLevel: previewBathymetryLevel
      });
    } catch (e) {
      if (generation == analysisGeneration) setBoxWater(e.message);
      return;
    }
    if (generation != analysisGeneration) return;
    analysis = result;
    if (gui.autoexpose) applyAnalysis();
    else describeWater();
  }

  // Real meters below which the preview takes NOAA depths: the water level the analysis is about to pick, or the typed one.
  function previewBathymetryLevel(water, floodShare, areaKm2) {
    if (!gui.include_oceans) return null;
    var k = heightScale();
    if (!gui.autoexpose) return Number(gui.waterLevel) / k;
    var choice = autoWaterChoice(waterChoices(water, k, floodShare), areaKm2);
    return choice ? choice.level / k : null;
  }

  function autoWaterChoice(choices, areaKm2) {
    return choices.filter(function(c) {
      return c.flood <= MAX_FLOOD_SHARE && c.flood * areaKm2 <= MAX_FLOOD_RATIO * c.areaKm2;
    })[0] || null;
  }

  // In-game water levels with their total surface area and the share of the map's dry land each would drown, largest first.
  function waterChoices(water, k, floodShare) {
    var choices = [];
    water.forEach(function(w) {
      var level = waterLevelFor(w, k);
      var same = choices.filter(function(c) { return c.level == level; })[0];
      if (same) same.areaKm2 += w.areaKm2;
      else choices.push({level: level, areaKm2: w.areaKm2, flood: floodShare(level / k)});
    });
    return choices.sort(function(a, b) { return b.areaKm2 - a.areaKm2; });
  }

  function describeWater() {
    try {
      var k = heightScale();
    } catch (e) {
      setBoxWater(e.message);
      return;
    }
    var shown = waterChoices(analysis.water, k, analysis.floodShare).filter(function(c, i) { return i == 0 || c.areaKm2 >= 0.1; });
    var depthNote = analysis.bathymetry && /unavailable/.test(analysis.bathymetry) ? ' (' + analysis.bathymetry + ')' : '';
    var climate = suggestClimate(analysis);
    var climateNote = climate ? '\nsuggested climate: ' + climate : '';
    if (!shown.length) {
      setBoxWater('no flat water surfaces found' + depthNote + climateNote);
      return;
    }
    setBoxWater('water levels: ' + shown.slice(0, 4).map(function(c) {
      var flood = c.flood > MAX_FLOOD_SHARE ? ', floods ' + Math.round(c.flood * 100) + '% of the map' : '';
      return c.level + ' (' + c.areaKm2.toFixed(1) + ' km2' + flood + ')';
    }).join(', ') + depthNote + climateNote);
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
    var min = Math.max(GAME_MIN_HEIGHT, Math.floor(k * analysis.min));
    var max = Math.min(GAME_MAX_HEIGHT, Math.max(min + 1, Math.ceil(k * analysis.max)));
    gui.minHeight = String(min);
    gui.maxHeight = String(max);
    var choice = autoWaterChoice(waterChoices(analysis.water, k, analysis.floodShare), analysis.areaKm2);
    gui.waterLevel = String(choice ? choice.level : Math.max(GAME_MIN_HEIGHT, min - 1));
    describeWater();
    refreshGUI();
    updateDisplayRange();
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
    gui.scaleFactor = ((h.max - h.min) / h.k / heightmapExport.groundWidth(exportBounds())) + '';
    controller('scaleFactor').updateDisplay();
  }

  function setStatus(text) {
    document.getElementById('status').textContent = text;
    inputError = false;
  }

  // Clears only a previous input error, so a correction doesn't wipe the last export's summary.
  function showInputError(message) {
    if (message) {
      setStatus(message);
      inputError = true;
    } else if (inputError) {
      setStatus('');
    }
  }
  
  // One export at a time, with failures reported in the status panel.
  async function runExport(label, task) {
    if (exporting) return;
    exporting = true;
    try {
      await task();
    } catch (e) {
      setStatus(label + ' failed: ' + e.message);
      console.error(e);
    } finally {
      exporting = false;
    }
  }

  function exportName() {
    return gui.fileName || 'heightmap';
  }

  function mapName() {
    return gui.mapSize + ' ' + gui.ratio + ' ' + gui.orientation;
  }

  async function buildHeightmap() {
    var floor = heightFloor();
    var h = readHeights();
    var out = outputSize();
    setStatus('Fetching elevation tiles...');
    var result = await heightmapExport.render({
      bounds: exportBounds(),
      width: out.width,
      height: out.height,
      bitDepth: Number(gui.bitDepth),
      floor: floor,
      ceiling: heightCeiling(),
      // Auto mode widens to whole in-game meters if full resolution finds a higher peak or lower point than the preview.
      range: function(lo, hi) {
        if (gui.autoexpose) {
          h.min = Math.max(GAME_MIN_HEIGHT, Math.min(h.min, Math.floor(h.k * lo)));
          h.max = Math.min(GAME_MAX_HEIGHT, Math.max(h.max, Math.ceil(h.k * hi)));
        }
        return {min: h.min / h.k, max: h.max / h.k};
      },
      bathymetryLevel: gui.include_oceans ? h.water / h.k : null,
      meta: {heightScale: h.k, waterLevel: h.water},
      onProgress: function(fraction) {
        setStatus('Fetching elevation tiles... ' + Math.round(fraction * 100) + '%');
      },
      onStage: setStatus
    });
    if (String(h.min) != gui.minHeight || String(h.max) != gui.maxHeight) {
      gui.minHeight = String(h.min);
      gui.maxHeight = String(h.max);
      refreshGUI();
      updateDisplayRange();
    }
    console.log('heightmap export', result.meta);
    return {blob: result.blob, meta: result.meta, heights: h};
  }

  function heightmapSummary(r) {
    var m = r.meta, h = r.heights;
    return [
      'Transport Fever import: Minimum Height ' + h.min + ', Maximum Height ' + h.max + ', Water Level ' + h.water,
      'height scale ' + h.k + ', real elevations ' + m.blackMeters.toFixed(2) + ' to ' + m.whiteMeters.toFixed(2) + ' m',
      'water depth: ' + (m.bathymetry || 'ocean data off, below sea level clamped to 0 m'),
      m.cappedFraction > 0 ? (m.cappedFraction * 100).toFixed(2) + '% of the map was above the game\'s ' + GAME_MAX_HEIGHT + ' m limit and was flattened. Lower the height scale to keep those peaks.' : null,
      'real ' + (m.metersPerPixel * (m.width - 1) / 1000).toFixed(2) + ' x ' + (m.metersPerPixel * (m.height - 1) / 1000).toFixed(2) + ' km at ' + m.metersPerPixel.toFixed(3) + ' m/px',
      'center ' + m.centerLat.toFixed(6) + ', ' + m.centerLng.toFixed(6),
      'bounds W ' + m.west.toFixed(6) + ' S ' + m.south.toFixed(6) + ' E ' + m.east.toFixed(6) + ' N ' + m.north.toFixed(6),
      'source zoom ' + m.sourceZoom + (m.upsampled ? ' (output is finer than the source data, upsampled)' : '')
    ].filter(function(line) { return line !== null; });
  }

  async function buildBiomes() {
    var h = readHeights();
    var out = outputSize();
    return heightmapExport.renderBiomes({
      bounds: exportBounds(),
      width: out.width,
      height: out.height,
      climate: gui.climate,
      waterLevel: h.water / h.k,
      onStage: setStatus
    });
  }

  function biomeSummary(result) {
    return [
      'biomes 0-4: ' + result.biomeShares.map(function(v) { return (v * 100).toFixed(1) + '%'; }).join(', '),
      result.layers.map(function(l) { return l.key + ' ' + (l.share * 100).toFixed(1) + '%'; }).join(', ')
    ];
  }

  function biomeFiles(result, name) {
    return [{path: name + '_biomes.png', blob: result.biomes}].concat(result.layers.map(function(l) {
      return {path: name + '_' + l.key + '.png', blob: l.blob};
    }));
  }

  async function buildTowns() {
    var out = outputSize();
    setStatus('Looking up towns...');
    var result = await townExport.build({
      bounds: exportBounds(),
      width: out.width,
      height: out.height,
      maxTowns: Math.round(gui.maxTowns),
      minSpacing: Number(gui.townSpacing),
      includeVillages: gui.includeVillages
    });
    townLayer.clearLayers().addTo(map);
    result.towns.forEach(function(t) {
      L.circleMarker([t.lat, t.lng], {radius: 4, color: '#ffcc00', weight: 2, fillOpacity: 0.8})
        .bindTooltip(t.name + ', size ' + t.size)
        .addTo(townLayer);
    });
    return result;
  }

  function townSummary(result) {
    var names = result.towns.map(function(t) { return t.name; });
    return [
      result.towns.length + ' towns, chosen from ' + result.candidates + ' places inside the map',
      names.slice(0, 10).join(', ') + (names.length > 10 ? ', ...' : '')
    ];
  }

  function exportRegion() {
    return runExport('Export', async function() {
      var r = await buildHeightmap();
      saveAs(r.blob, exportName() + '.png');
      setStatus(['Saved ' + mapName() + ', ' + r.meta.width + 'x' + r.meta.height + ' ' + r.meta.bitDepth + '-bit grayscale']
        .concat(heightmapSummary(r)).join('\n'));
    });
  }

  function exportBiomeMaps() {
    return runExport('Biome export', async function() {
      var result = await buildBiomes();
      var files = biomeFiles(result, exportName());
      files.forEach(function(f) { saveAs(f.blob, f.path); });
      var out = outputSize();
      setStatus(['Saved ' + files.map(function(f) { return f.path; }).join(', ') + ', ' + out.width + 'x' + out.height + ', ' + gui.climate]
        .concat(biomeSummary(result), ['Put them in the game\'s biomes folder and import them after the heightmap.']).join('\n'));
    });
  }

  function exportTowns() {
    return runExport('Town export', async function() {
      var result = await buildTowns();
      saveAs(new Blob([result.lua], {type: 'text/plain'}), exportName() + '_towns.lua');
      var lines = townSummary(result);
      lines[0] = 'Saved ' + lines[0];
      setStatus(lines.join('\n'));
    });
  }

  // Laid out like the game's user data folder, so extracting it there puts every file where its import dialog looks.
  function exportAll() {
    return runExport('Export all', async function() {
      var name = exportName();
      var heightmap = await buildHeightmap();
      var biomes = await buildBiomes();
      var towns = await buildTowns();
      setStatus('Writing ' + name + '.zip...');
      var zip = await heightmapExport.zip([
        {path: 'heightmaps/' + name + '.png', blob: heightmap.blob}
      ].concat(biomeFiles(biomes, name).map(function(f) {
        return {path: 'biomes/' + f.path, blob: f.blob};
      }), [
        {path: 'towns_industries/' + name + '.lua', blob: new Blob([towns.lua], {type: 'text/plain'})}
      ]));
      saveAs(zip, name + '.zip');
      setStatus(['Saved ' + name + '.zip for ' + mapName() + ', ' + gui.climate + '. Extract it into the Transport Fever 3 user folder, %APPDATA%\\Transport Fever 3.']
        .concat(heightmapSummary(heightmap).slice(0, 4), biomeSummary(biomes), townSummary(towns)).join('\n'));
    });
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
      gui = new dat.GUI({ autoPlace: true, hideable: true, width: 300 });
      addGUI();
      // resetViewComplete();
      scene.subscribe({
        // will be triggered when tiles are finished loading
        // and also manually by the moveend event
        view_complete: function() {
        }
      });

      heightFieldsEditable(false);
      if (startAtDefaults) applyScale();
      updateExportBox();
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

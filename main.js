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
  // Lowest Minimum Height the game's import dialog accepts.
  const GAME_MIN_HEIGHT = -100;
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

    gui.include_oceans = false;
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
    map.setView(c, map.getZoom(), {animate: false});
    map.setZoom(map.getZoom() + Math.log2(metersPerPixel() / mpp), {animate: false});
  }

  function applyScale() {
    var target = Number(gui.metersPerPixel);
    if (!(target > 0)) {
      showInputError('real meters per pixel must be a positive number');
      return;
    }
    showInputError(null);
    map.setZoom(map.getZoom() + Math.log2(metersPerPixel() / target), {animate: false});
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
      var result = await heightmapExport.analyze({bounds: exportBounds(), aspect: (out.width - 1) / (out.height - 1), floor: floor});
    } catch (e) {
      if (generation == analysisGeneration) setBoxWater(e.message);
      return;
    }
    if (generation != analysisGeneration) return;
    analysis = result;
    if (gui.autoexpose) applyAnalysis();
    else describeWater();
  }

  // In-game water levels with their total surface area, largest first.
  function waterChoices(k) {
    var choices = [];
    analysis.water.forEach(function(w) {
      var level = waterLevelFor(w, k);
      var same = choices.filter(function(c) { return c.level == level; })[0];
      if (same) same.areaKm2 += w.areaKm2;
      else choices.push({level: level, areaKm2: w.areaKm2});
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
    var shown = waterChoices(k).filter(function(c, i) { return i == 0 || c.areaKm2 >= 0.1; });
    if (!shown.length) {
      setBoxWater('no flat water surfaces found');
      return;
    }
    setBoxWater('water levels: ' + shown.slice(0, 4).map(function(c) {
      return c.level + ' (' + c.areaKm2.toFixed(1) + ' km2)';
    }).join(', '));
  }

  function applyAnalysis() {
    try {
      var k = heightScale();
    } catch (e) {
      showInputError(e.message);
      return;
    }
    var min = Math.max(GAME_MIN_HEIGHT, Math.floor(k * analysis.min));
    var max = Math.max(min + 1, Math.ceil(k * analysis.max));
    gui.minHeight = String(min);
    gui.maxHeight = String(max);
    var choices = waterChoices(k);
    gui.waterLevel = String(choices.length ? choices[0].level : Math.max(GAME_MIN_HEIGHT, min - 1));
    describeWater();
    refreshGUI();
    updateDisplayRange();
  }

  function readHeights() {
    var k = heightScale();
    var min = Number(gui.minHeight), max = Number(gui.maxHeight), water = Number(gui.waterLevel);
    if (!isFinite(min) || !isFinite(max) || !(max > min)) throw new Error('maximum height must be above minimum height');
    if (min < GAME_MIN_HEIGHT) throw new Error('minimum height cannot be below ' + GAME_MIN_HEIGHT + ', the lowest the game accepts');
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
  
  async function exportRegion() {
    if (exporting) return;
    exporting = true;
    try {
      var floor = heightFloor();
      var h = readHeights();
      var out = outputSize();
      var mapName = gui.mapSize + ' ' + gui.ratio + ' ' + gui.orientation;
      setStatus('Fetching elevation tiles...');
      var result = await heightmapExport.render({
        bounds: exportBounds(),
        width: out.width,
        height: out.height,
        bitDepth: Number(gui.bitDepth),
        floor: floor,
        // Auto mode widens to whole in-game meters if full resolution finds a higher peak or lower point than the preview.
        range: function(lo, hi) {
          if (gui.autoexpose) {
            h.min = Math.max(GAME_MIN_HEIGHT, Math.min(h.min, Math.floor(h.k * lo)));
            h.max = Math.max(h.max, Math.ceil(h.k * hi));
          }
          return {min: h.min / h.k, max: h.max / h.k};
        },
        meta: {heightScale: h.k, waterLevel: h.water},
        onProgress: function(fraction) {
          setStatus('Fetching elevation tiles... ' + Math.round(fraction * 100) + '%');
        }
      });
      var m = result.meta;
      if (String(h.min) != gui.minHeight || String(h.max) != gui.maxHeight) {
        gui.minHeight = String(h.min);
        gui.maxHeight = String(h.max);
        refreshGUI();
        updateDisplayRange();
      }
      saveAs(result.blob, (gui.fileName || 'heightmap') + '.png');
      setStatus([
        'Saved ' + mapName + ', ' + m.width + 'x' + m.height + ' ' + m.bitDepth + '-bit grayscale',
        'Transport Fever import: Minimum Height ' + h.min + ', Maximum Height ' + h.max + ', Water Level ' + h.water,
        'height scale ' + h.k + ', real elevations ' + m.blackMeters.toFixed(2) + ' to ' + m.whiteMeters.toFixed(2) + ' m',
        'real ' + (m.metersPerPixel * (m.width - 1) / 1000).toFixed(2) + ' x ' + (m.metersPerPixel * (m.height - 1) / 1000).toFixed(2) + ' km at ' + m.metersPerPixel.toFixed(3) + ' m/px',
        'center ' + m.centerLat.toFixed(6) + ', ' + m.centerLng.toFixed(6),
        'bounds W ' + m.west.toFixed(6) + ' S ' + m.south.toFixed(6) + ' E ' + m.east.toFixed(6) + ' N ' + m.north.toFixed(6),
        'source zoom ' + m.sourceZoom + (m.upsampled ? ' (output is finer than the source data, upsampled)' : '')
      ].join('\n'));
      console.log('heightmap export', m);
    } catch (e) {
      setStatus('Export failed: ' + e.message);
      console.error(e);
    } finally {
      exporting = false;
    }
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

# heightmapper-tf

https://skyl3lazer.github.io/heightmapper-tf/

A fork of [tangrams/heightmapper](https://github.com/tangrams/heightmapper) that exports real-world terrain as heightmaps for Transport Fever 2 and Transport Fever 3.

<img width="900" alt="screen shot 2016-07-19 at 11 17 17 am" src="https://cloud.githubusercontent.com/assets/459970/16955404/6e9ec51e-4da2-11e6-97e1-d43d2682e07b.png">

### Usage

1. Pick the map size, ratio and orientation in the "heightmap export" panel. The red box in the middle of the view shows the area that will be exported.
2. Pan and zoom until the box covers the region you want. 
3. Customize any generator options such as climate, town count, etc.
4. Click "export all" for a zip with the heightmap, biome maps and towns, laid out like the game's user folder. Extract it into `%APPDATA%\Transport Fever 3`. The individual export buttons save single files instead.
5. In the map editor, create a map of the size and climate you've chosen.
6. In the game's Import Heightmap dialog, enter the "minimum height", "maximum height" and "water level" shown at the top of the panel.
7. Import the heightmap, biomes, and town files.
8. Generate industries.

You now have a fully playable map!

Other controls:

- maximum height, minimum height, water level: the values to enter in the game. With auto-exposure on they are measured from the area inside the box, or you can type your own. The game accepts heights from -100 to 3177. Auto-exposure lowers the height scale just enough to fit the highest point under 3177. It returns to your scale when you move somewhere lower. With auto-exposure off, terrain above 3177 is flattened.
- The box label lists the water levels of the flat water surfaces it finds (seas, lakes, reservoirs), largest first, with their area. Transport Fever has a single water level, so pick the one you want and enter it in the game. Auto-exposure picks the largest water body that doesn't flood the entire map, but it's not going to work in every situation.
- climate: the Transport Fever 3 climate the map is for. The box label suggests one from the latitude and land cover inside the box.
- export biomes: writes `<file name>_biomes.png` plus the climate's masks for Transport Fever 3's Biomes import, the same size as the heightmap. Temperate gets mountains and rivers, Dry gets coast hills, mountains and rivers, Tropical gets islands, mountains and volcanoes, and Subarctic gets lakes, mountains and swamps. Biomes come from Esri's Sentinel-2 land cover and real-world slope. Browsers may ask to allow multiple downloads the first time.
- height scale: in-game height per real meter. 1 keeps real heights. Heights scale around sea level, so the sea stays at the water level.
- include ocean data / ocean floor (m): Water below the water level takes its depth from NOAA's DEM Global Mosaic, which has real depths where the elevation tiles store water as a flat surface, and the ocean floor sets the lowest point allowed. With it off, everything below sea level is clamped to 0 m. The game's lowest minimum height is -100.
- bit depth: 16-bit grayscale PNG with no alpha channel by default. 8-bit is also available but its height steps are coarse.
- export all: runs the heightmap, biome and town exports and saves them together as `<file name>.zip`.
- reference map: overlays OpenStreetMap for finding places.
- screenshot: saves the current view as an 8-bit image for testing.
- Press the "h" key to toggle UI visibility.

Images generate at 256 px per in-game km plus 1 on each axis, e.g. 7169 x 7169 for a 28 x 28 km Gigantomaniac map.

The live values come from a coarse preview of the box. If the full-resolution export finds a higher peak or a lower point, it widens the range and updates the fields, so always enter the values shown after the export. The bottom-left panel also shows those values, and the PNG's `Description` text chunk stores them as JSON.

Water levels can only be found where the elevation data stores water as perfectly flat surfaces. Generally this exists for lakes, reservoirs, rivers and the sea.

Elevation data comes from the [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) open dataset (terrarium encoding, zoom 0-15, no API key). The tiles contain a few known bad patches with wrong values, mostly along coastlines, but they'll generally get smoothed out when you export. Neighboring tiles are sometimes built from different surveys, which leaves straight steps along their shared edges. The export also measures those steps and blends them out.

### Publishing

The site is static and is published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

One-time setup: in the repository's Settings, open Pages and set "Source" to "GitHub Actions". After the next push to `main`, or a manual run of the "Publish to GitHub Pages" workflow from the Actions tab, the site is live at https://skyl3lazer.github.io/heightmapper-tf/.

Town export looks up places through a keyed Overpass service when one is configured, and falls back to the free public Overpass instances otherwise. To configure it, add two environment secrets to the `github-pages` environment (Settings, Environments, github-pages):

- `OVERPASS_URL`: the service URL, with `{key}` where the key goes, e.g. `https://overpass.nextgis.com/{key}/api/interpreter`.
- `OVERPASS_KEY`: the API key.

The workflow writes them into `config.js` when it publishes. The site has no server, so the published `config.js` is readable by anyone who visits the page. The secrets only keep the key out of the repository.

### To run locally:

Start a web server in the repo's directory:

    python -m http.server 8000

If running this produces CORS errors on your local machine, try:

    python run-server.py

Then navigate to: [http://localhost:8000](http://localhost:8000)

To use a keyed Overpass service locally, copy `config.example.js` to `config.js` and fill it in. Git ignores `config.js`. Without it, town export uses the public instances.

[![AI-DECLARATION: copilot](https://img.shields.io/badge/䷼%20AI--DECLARATION-copilot-fee2e2?labelColor=fee2e2)](https://ai-declaration.md)

*This declaration applies only to the fork's content. See [AI-DECLARATION.md](AI-DECLARATION.md) for specifics.*
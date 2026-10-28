# heightmapper-tf

https://skyl3lazer.github.io/heightmapper-tf/

A fork of [tangrams/heightmapper](https://github.com/tangrams/heightmapper) that exports real-world terrain as heightmaps for Transport Fever 2 and Transport Fever 3.

<img width="900" alt="screen shot 2016-07-19 at 11 17 17 am" src="https://cloud.githubusercontent.com/assets/459970/16955404/6e9ec51e-4da2-11e6-97e1-d43d2682e07b.png">

### Usage

1. Pick the map size, ratio and orientation in the "heightmap export" panel. The red box in the middle of the view shows the area that will be exported.
2. Pan and zoom until the box covers the region you want. Hold Shift while scrolling to zoom in fine steps.
3. Customize any generator options such as climate, town count, etc.
4. Click "export all" for a zip with the heightmap, biome maps and towns, laid out like the game's user folder. Extract it into `%APPDATA%\Transport Fever 3`. The individual export buttons save single files instead.
5. In the map editor, create a map of the size and climate you've chosen.
6. In the game's Import Heightmap dialog, enter the "minimum height", "maximum height" and "water level" shown at the top of the panel.
7. Import the heightmap, biomes, and town files. You may want to save+reload the map after importing the biomes to remove the gridlines that the game will generate.
8. Generate industries.

You now have a fully playable map!

### Other controls:

- maximum height, minimum height, water level: the values to enter in the game. With auto-exposure on, they are measured from the area inside the box. The game accepts heights from -100 to 3177. Auto-exposure lowers the height scale or steepness just enough to fit the highest point under 3177. It returns to your value when you move somewhere lower. With auto-exposure off, you type your own values. Terrain above 3177 is then flattened.
- The box label lists the water levels of the flat water surfaces it finds (seas, lakes, reservoirs), largest first, with their area. Transport Fever has a single water level. Pick the one you want and enter it in the game. Auto-exposure picks the largest water body that doesn't flood the entire map. This won't work in every situation.
- rotation (degrees): turns the box clockwise on the map. The map zooms slightly as you turn it so that real meters per pixel stays the same.
- climate: the Transport Fever 3 climate the map is for. The box label suggests one from the latitude and land cover inside the box.
- export biomes: writes `<file name>_biomes.png` plus the climate's masks for Transport Fever 3's Biomes import, the same size as the heightmap. Based on climate, this includes:
    - temperate: mountains, and rivers
    - dry: coast hills, mesas, monument valley, mountains, and rivers
    - tropical: islands, mountains, and volcanoes
    - subarctic: lakes, mountains, and swamps
- scale by, height scale, steepness: how real heights become in-game heights. Height scale is in-game height per real meter. A height scale of 1 keeps real heights. Steepness is how many times steeper than real the slopes come out. The game draws each pixel 4 m wide. A map covering more than 4 real meters per pixel squeezes the land sideways, leading to crazy tall mountains. "Scale by" lets you switch between modes to find whatever you think looks best. Steepness above 4x or so will look weird depending on the region. Heights scale around sea level so it stays at the water level.
- smoothing (in-game m): blurs the land over roughly this distance in the game's own meters, to calm bumpy real-world data. 0 turns it off. Water and the shoreline are left as they are.
- ocean floor (m): Water below the water level takes its depth from NOAA's DEM Global Mosaic which has real depths where the elevation tiles store water as a flat surface. Riverbeds are estimated where NOAA data doesn't exist for large rivers inland. The ocean floor sets the lowest in-game height allowed. The game's lowest minimum height is -100.
- water normalization: TF doesn't model water flow. It has only one water level. This option takes major water sources and attempts to bring them to the set water level. Rivers/lakes/etc at different elevations can then fill. They embed by gently sloping back to normal terrain height, up to ~10m difference in height.
- max water displacement (m): shown while water normalization is on. It sets the most in-game meters a river or lake is lowered to reach the water level. Water sitting higher stays dry. The default is 100. Raise it for high lakes at the cost of a deeper bowl around them.
- shore antialiasing: shown while water normalization is on, and on by default. It drops specks of water and land, smooths the shoreline's pixel steps, and blends the step at the water into the bank so the shore keeps its realistic slope.
- bit depth: 16-bit grayscale PNG with no alpha channel by default. 8-bit is also available. Its height steps are coarse.
- town names: take latin-character only names or the original accented/character names.
- generation safety:
    - 'none' picks purely by population. 'Dangerous' placements show in orange. They might not work in game because they sit close to water or lack nearby land.
    - 'skip dangerous' skips those ones instead and takes others.
    - 'nudge-skip': moves an unsafe town to the nearest safe pixel within 200 m that it can reach over land. If the center is in water, it starts from the nearest shore. If there's no such pixel, the town is skipped. Nudged towns show in blue.
    - 'nudge-force': takes the nearest safe pixel within 200 m in a straight line, even across water. If there's none, the town is skipped. Nudged towns show in blue.
- export all: runs the heightmap, biome and town exports and saves them together as `<file name>.zip`.
- reference map: overlays OpenStreetMap for finding places.
- Press the "h" key to toggle UI visibility.

#### Export Info

Images generate at 256 px per in-game km plus 1 on each axis, e.g. 7169 x 7169 for a 28 x 28 km Gigantomaniac map.

The live values come from a coarse preview of the box. If the full-resolution export finds a higher peak or a lower point, it widens the range. Always enter the values from the finished task in the bottom-left panel. The PNG's `Description` text chunk also stores them as JSON.

Water levels can only be found where the elevation data stores water as perfectly flat surfaces. Generally this exists for lakes, reservoirs, rivers and the sea.

### Data Sources

- [Mapterhorn](https://mapterhorn.com/attribution/) - Base elevation map tiles
- [OpenStreetMap](https://www.openstreetmap.org) - Reference map overlay
- [NOAA DEM Global Mosaic](https://www.ncei.noaa.gov/maps-and-geospatial-products) - Bathymetry (underwater elevations)
- [Esri / Impact Observatory (Sentinel2)](https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer) - Land Usage for biome mapping
- [NextGIS](https://nextgis.com/) - OpenStreetMap's Overpass API data for town data, volcano locations, and rivers
    - Backups for overpass provided by [Private.coffee](https://overpass.private.coffee),
    [Maps.mail.ru](https://maps.mail.ru/osm/tools/overpass/), and [Overpass](https://overpass-api.de/)
- [Natural Earth](https://www.naturalearthdata.com) - Major river courses for maps too large for an OpenStreetMap river lookup (public domain)

### Publishing

The site is static and is published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

One-time setup: in the repository's Settings, open Pages and set "Source" to "GitHub Actions". After the next push to `main`, or a manual run of the "Publish to GitHub Pages" workflow from the Actions tab, the site is live at https://skyl3lazer.github.io/heightmapper-tf/ (or your own equivalent).

Town export looks up places through a keyed Overpass service when one is configured. Otherwise it falls back to the free public Overpass instances. To configure it, add two environment secrets to the `github-pages` environment (Settings, Environments, github-pages):

- `OVERPASS_URL`: the service URL, with `{key}` where the key goes, e.g. `https://overpass.nextgis.com/{key}/api/interpreter`.
- `OVERPASS_KEY`: the API key.

The workflow writes them into `config.js` when it publishes.

**NOTE**: The site has no server. The published `config.js` is therefore readable by anyone who visits the page. The secrets only keep the key out of the repository. For NextGIS this is intentional.

### To run locally:

Start a web server in the repo's directory:

    python -m http.server 8000

If running this produces CORS errors on your local machine, try:

    python run-server.py

Then navigate to: [http://localhost:8000](http://localhost:8000)

To use a keyed Overpass service locally, copy `config.example.js` to `config.js` and fill it in. Git ignores `config.js`. Without it, town export uses the public instances.

[![AI-DECLARATION: copilot](https://img.shields.io/badge/䷼%20AI--DECLARATION-copilot-fee2e2?labelColor=fee2e2)](https://ai-declaration.md)

*This declaration applies only to the fork's content. See [AI-DECLARATION.md](AI-DECLARATION.md) for specifics.*
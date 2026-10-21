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
7. Import the heightmap, biomes, and town files. You may want to save+reload the map after importing the biomes to remove the gridlines that the game will generate.
8. Generate industries.

You now have a fully playable map!

### Other controls:

- maximum height, minimum height, water level: the values to enter in the game. With auto-exposure on they are measured from the area inside the box, or you can type your own. The game accepts heights from -100 to 3177. Auto-exposure lowers the height scale or steepness just enough to fit the highest point under 3177. It returns to your value when you move somewhere lower. With auto-exposure off, terrain above 3177 is flattened.
- The box label lists the water levels of the flat water surfaces it finds (seas, lakes, reservoirs), largest first, with their area. Transport Fever has a single water level, so pick the one you want and enter it in the game. Auto-exposure picks the largest water body that doesn't flood the entire map, but it's not going to work in every situation.
- climate: the Transport Fever 3 climate the map is for. The box label suggests one from the latitude and land cover inside the box.
- export biomes: writes `<file name>_biomes.png` plus the climate's masks for Transport Fever 3's Biomes import, the same size as the heightmap. Based on climate, this includes: 
    - temperate: mountains, and rivers
    - dry: coast hills, mesas, monument valley, mountains, and rivers
    - tropical: islands, mountains, and volcanoes
    - subarctic: lakes, mountains, and swamps
- draw state borders / border width (m): draws the state borders from OpenStreetMap on the land as a strip of the hills biome, which the game shows as paler, drier grass. The game blends biomes and only paints its masks near water or on slopes, so the strip is subtle and needs to be wide: 64 in-game m by default. Borders through lakes and out at sea are left out. Along a river the strip mostly lies on its bed. Off by default.
- scale by, height scale, steepness: how real heights become in-game heights. Height scale is in-game height per real meter, so 1 keeps real heights. Steepness is how many times steeper than real the slopes come out. The game draws each pixel 4 m wide, so a map covering more real ground than that squeezes the land sideways, leading to crazy tall mountains. "Scale by" lets you switch between modes to find whatever you think looks best. Steepness above 4x or so will look weird depending on the region. Heights scale around sea level, so the sea stays at the water level.
- smoothing (in-game m): blurs the land over roughly this distance in the game's own meters, to calm bumpy real-world data. 0 turns it off. Water and the shoreline are left as they are.
- remove tree canopy: the elevation data measures the tops of the trees, so forests stand a few meters above the fields beside them, with a step at every forest edge. This takes the canopy height, measured across the forest edges of each export, off forest on gentle land and softens what is left of the edges. Where the data is bare ground, nothing changes. On by default.
- relief shaping: scales the small hills and valleys on the land, those under about 20 pixels across. Flat land's grow up to the lowland detail factor, since at small height scales it otherwise reads as a table in the game, and rough land's shrink toward the mountain relief height, so mountains keep their shape without needle peaks. Shores and the land just around water keep the shape they were given. Auto, the default, shapes maps at least 2 times as steep as real. lowland detail (x): 2.5 by default, 1 leaves flat land as it is. mountain relief (m): about how tall in in-game meters rough land's hills and valleys end up, 12 by default.
- include ocean data / ocean floor (m): Water below the water level takes its depth from NOAA's DEM Global Mosaic, which has real depths where the elevation tiles store water as a flat surface, and the ocean floor sets the lowest in-game height allowed. With it off, everything below sea level is clamped to 0 m, except river beds cut by water normalization. Dry land the elevation data puts at the water level, like a sand spit too narrow for land cover's grid, is found with land cover at the map's own resolution and raised just above the water, as polders are. The game's lowest minimum height is -100. This option also controls riverbed generation where NOAA data doesn't exist for large rivers inland.
- water normalization: TF doesn't model water flow and only has one water level. This option takes major water sources and attempts to bring them to the set water level to ensure that rivers/lakes/etc at different elevations can fill. The land around them goes down with them, as far as the least lowered water nearby, so a basin whose rivers all sit high keeps its own slopes instead of turning into funnels. Only what's left slopes gently back to normal terrain height. Their shores slope gently into the water instead of standing as a one-pixel step, and pits of water too small to be lakes are filled.
- max water displacement (m): shown while water normalization is on. The most in-game meters a river or lake is lowered to reach the water level. Water sitting higher stays dry. 100 by default. Raise it to carve higher rivers and lakes, which lowers the land around them by as much.
- carve rivers wider than: shown while water normalization is on, like the rows below. Rivers at least this many real meters across are carved into the heightmap. 0 m, the default, carves every river found. Changing it resets the checkboxes in the river list.
- channel min width / channel max width (m): the narrowest and widest in-game channel a carved river gets. A river's width at the map's scale grows into its in-game width by its square root, so narrow rivers come out wider than real and great ones narrower, kept between these two. 16 and 200 by default. Rivers that land cover sees keep at least their real width there.
- channel max depth (m): how deep in in-game meters a river bed is cut below the water level. Beds are a quarter as deep as the channel is wide, at least 4 m, up to this, and slope up to the banks at 2 m per pixel. Channels narrow and get shallower over their last 100 in-game m. A few pixels of land too high to cut across a channel, like an embankment, are cut through. 12 by default. With ocean data on they stop at the ocean floor, and without it at the game's -100. With auto-exposure off the minimum height you type also limits them.
- navigable rivers wider than / navigable width (m): rivers at least this many real meters across get a channel at least the navigable width, room for ships, which need about 70 m, and a river port. They get it where they run up to 250 real m above the water level, and narrow back to their own width over the next 100 m up, so the mountain valleys they rise in aren't flooded. 180 m and 100 m by default.
- find rivers: looks up the rivers in the box and ranks them by real width: from their OpenStreetMap width tags where those cover most of the river, else as land cover measures them, else as Natural Earth ranks them, else from their length and any width tags it has. They are drawn on the map, blue where carved and gray where left out, and the widest are listed under the button with checkboxes. Click a river on the map or tick its box to switch it. The rest follow the width threshold. Exports look the rivers up themselves when you skip this. Your checkboxes stay with each river by name, even after the box moves, until you change the width threshold. Streams that only share a name are separate rivers, listed with where they start. A carved river also carves the river it flows into, unless that one is unchecked, so no channel ends in dry land. A river left out is not lowered to the water level, so where it runs higher it stays dry land. Lakes and reservoirs it runs through stay. On maps big enough for Natural Earth's rivers, the list switches them by tier. Biomes still take water from land cover, so a river left out keeps its river biome.
- bit depth: 16-bit grayscale PNG with no alpha channel by default. 8-bit is also available but its height steps are coarse.
- town names: take latin-character only names or the original accented/character names.
- generation safety: 
    - 'none' picks purely by population with 'dangerous' placements, those which might not work in game because of their proximity to water or lack of nearby land available, shown in orange. 
    - 'skip dangerous' skips those ones instead and takes others.   
    - 'nudge-skip': moves an unsafe town to the nearest safe pixel within 200 m that it can reach over land. If the center is in water, it starts
    from the nearest shore. If there's no such pixel, the town is skipped. Nudged towns shown in blue.
    - 'nudge-force': takes the nearest safe pixel within 200 m in a straight line, even across water. If there's none, the town is skipped. Nudged towns shown in blue.
- export all: runs the heightmap, biome and town exports and saves them together as `<file name>.zip`.
- reference map: overlays OpenStreetMap for finding places.
- Press the "h" key to toggle UI visibility.

#### Export Info

Images generate at 256 px per in-game km plus 1 on each axis, e.g. 7169 x 7169 for a 28 x 28 km Gigantomaniac map.

The live values come from a coarse preview of the box. If the full-resolution export finds a higher peak or a lower point, it widens the range, so always enter the values from the finished task in the bottom-left panel. The PNG's `Description` text chunk also stores them as JSON.

Water levels can only be found where the elevation data stores water as perfectly flat surfaces. Generally this exists for lakes, reservoirs, rivers and the sea.

Elevation data comes from the [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) open dataset (terrarium encoding, zoom 0-15, no API key). The tiles contain a few known bad patches with wrong values, from single pixels to whole tiles of noise. The export replaces them with the next coarser zoom level's data. Neighboring tiles are sometimes built from different surveys, which can leave straight steps along their shared edges. The export also measures those steps and blends them out.

### Data Sources

- [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) - Base elevation map tiles
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

Town export looks up places through a keyed Overpass service when one is configured, and falls back to the free public Overpass instances otherwise. To configure it, add two environment secrets to the `github-pages` environment (Settings, Environments, github-pages):

- `OVERPASS_URL`: the service URL, with `{key}` where the key goes, e.g. `https://overpass.nextgis.com/{key}/api/interpreter`.
- `OVERPASS_KEY`: the API key.

The workflow writes them into `config.js` when it publishes. 

**NOTE**: The site has no server, so the published `config.js` is readable by anyone who visits the page. The secrets only keep the key out of the repository. For NextGIS this is intentional.

### To run locally:

Start a web server in the repo's directory:

    python -m http.server 8000

If running this produces CORS errors on your local machine, try:

    python run-server.py

Then navigate to: [http://localhost:8000](http://localhost:8000)

To use a keyed Overpass service locally, copy `config.example.js` to `config.js` and fill it in. Git ignores `config.js`. Without it, town export uses the public instances.

[![AI-DECLARATION: copilot](https://img.shields.io/badge/䷼%20AI--DECLARATION-copilot-fee2e2?labelColor=fee2e2)](https://ai-declaration.md)

*This declaration applies only to the fork's content. See [AI-DECLARATION.md](AI-DECLARATION.md) for specifics.*
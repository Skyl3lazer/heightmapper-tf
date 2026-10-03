# heightmapper-tf

https://skyl3lazer.github.io/heightmapper-tf/

A fork of [tangrams/heightmapper](https://github.com/tangrams/heightmapper) that exports real-world terrain as heightmaps for Transport Fever 2 and Transport Fever 3.

<img width="900" alt="screen shot 2016-07-19 at 11 17 17 am" src="https://cloud.githubusercontent.com/assets/459970/16955404/6e9ec51e-4da2-11e6-97e1-d43d2682e07b.png">

### Usage

1. Pick the map size, ratio and orientation in the "heightmap export" panel. The red box in the middle of the view shows the area that will be exported.
2. Pan and zoom until the box covers the region you want. "center (lat, lon)" and "real meters per pixel" follow the map, and you can type into them to jump to an exact spot or scale.
3. Click "export heightmap".
4. In the game's Import Heightmap dialog, enter the "minimum height", "maximum height" and "water level" shown at the top of the panel.

Other controls:

- maximum height, minimum height, water level: the values to enter in the game. With auto-exposure on they are measured from the area inside the box, or you can type your own.
- The box label lists the water levels of the flat water surfaces it finds (seas, lakes, reservoirs), largest first, with their area. Transport Fever has a single water level, so pick the one you want and enter it in the game.
- height scale: in-game height per real meter. 1 keeps real heights. Heights scale around sea level, so the sea stays at the water level.
- include ocean data / ocean floor (m): with ocean data on, set the lowest point of the ocean. With it off, everything below sea level is clamped to 0 m. The game's lowest minimum height is -100.
- bit depth: 16-bit grayscale PNG with no alpha channel by default. 8-bit is also available but its height steps are coarse.
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
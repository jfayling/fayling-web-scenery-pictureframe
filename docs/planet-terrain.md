# Moon terrain

Under Settings → Scenery, set **Scenes** to **One region**.
Then select a **Moon** scene in **Region**.
Alternatively, open `scenery.html?scene=moon` or `http://localhost:8081/?scene=moon`.
The tour includes five lunar regions after the nine Earth regions.

| Scene | URL parameter | Route |
|---|---|---|
| Copernicus | `?scene=moon` | Southern rim, floor, central peaks, northern rim |
| Aristarchus Plateau | `?scene=moon-aristarchus` | Aristarchus crater, valley mouth, Vallis Schröteri, northern plateau |
| Hadley–Apennine | `?scene=moon-hadley` | Southern mountains, Hadley Rille, Apollo 15 region, mountain front |
| Tycho | `?scene=moon-tycho` | Southern highlands, terraced walls, central peaks, northern rim |
| Orientale | `?scene=moon-orientale` | Northern basin floor and Rook mountain rings |

Orientale shows part of the basin and its mountain rings. The crop does not contain the entire outer basin.
The Apollo 15 region uses measured terrain. It does not include spacecraft models or landing-site markers.

The Copernicus camera follows seven waypoints across the crater. Each additional region has six geographic waypoints.
Smooth curves connect the waypoints without sharp heading changes.
Target clearance decreases from 5.5 km on approach to 2.4 km over the floor, then increases for the exit.
The camera pitch changes gradually along the route. The Flight altitude and Camera tilt controls still apply.
The terrain probes control camera clearance with the same elevation samples that supply the mesh.
Lunar probes extend about 13 km ahead along the curved route to anticipate rising terrain.
At the route endpoint, the scene fades into the next tour scene or restarts in single-scene mode.
At Speed 1, a tour completes the route in approximately the selected scene duration, plus fades.
Single-scene mode completes the full route before restarting.
Cruising speeds are 180 m/s for Copernicus, 170 for Aristarchus, 95 for Hadley, 160 for Tycho, and 350 for Orientale.
The Speed control changes these travel times. Free flight suspends the route.
Autopilot rejoins at the current north–south position and eases lateral offsets back toward the route.
Free flight stays inside the measured crop.

## Elevation source

The elevation source is [SLDEM2015 from NASA/GSFC and the MIT LOLA archive](https://pgda.gsfc.nasa.gov/products/54).
This product combines LRO laser altimetry with SELENE/Kaguya stereo terrain measurements.
The source [PDS label](https://imbrium.mit.edu/DATA/SLDEM2015/TILES/FLOAT_IMG/SLDEM2015_256_0N_60N_240_360_FLOAT.LBL) defines the units, byte order, dimensions, and reference radius.

The original Copernicus crop has these properties:

| Property | Value |
|---|---|
| Source product | `SLDEM2015_256_0N_60N_240_360_FLOAT` |
| Source grid | 256 samples per degree, about 118 m north–south |
| Crop bounds | 5–15° N, 335–345° E |
| Bundled grid | 1280 × 1280 samples, about 237 m north–south |
| Horizontal extent | Approximately 299 × 303 km |
| Height reference | Metres above a 1,737,400 m sphere |
| Encoding | Lossless gradient prediction, zigzag byte planes, then gzip |
| Processing | Average each 2 × 2 source block, then round to the nearest metre |
| Orientation | Rows run north to south. Columns run west to east. |

The additional crops use the same height reference, encoding, and orientation:

| Region | Latitude bounds | Longitude bounds (east) | Grid | North–south sample spacing | Source averaging |
|---|---|---|---|---|---|
| Aristarchus | 20–30° N | 305–315° | 1280 × 1280 | 237 m | 2 × 2 at 256 samples/degree |
| Hadley | 24–28° N | 2–6° | 2048 × 2048 | 59 m | Native 512 samples/degree |
| Tycho | 48–38° S | 344–354° | 1280 × 1280 | 237 m | 2 × 2 at 256 samples/degree |
| Orientale | 32–8° S | 253–277° | 1536 × 1536 | 474 m | 4 × 4 at 256 samples/degree |

East–west sample spacing decreases with latitude. Grid spacing does not guarantee the same effective resolution everywhere.
Aristarchus uses the same source tile as Copernicus.
Tycho and Orientale use `SLDEM2015_256_60S_0S_240_360_FLOAT`.
Hadley uses `SLDEM2015_512_00N_30N_000_045_FLOAT`.
The [MIT source directory](https://imbrium.mit.edu/DATA/SLDEM2015/TILES/FLOAT_IMG/) contains their images and PDS labels.

Citation: Barker, M. K. et al. (2016), “A new lunar digital elevation model from the Lunar Orbiter Laser Altimeter and SELENE Terrain Camera.”
*Icarus*, 273, 346–355. [DOI: 10.1016/j.icarus.2015.07.039](https://doi.org/10.1016/j.icarus.2015.07.039).

The generated `js/moon*-data.js` files record source URLs, bounds, elevation limits, and SHA-256 checksums.
The codec stores differences from a prediction based on the left, upper, and upper-left samples.
It maps signed differences to unsigned values, separates the low and high bytes, then applies gzip compression.
The decoder restores every signed 16-bit elevation exactly. The elevation checksums refer to the decoded little-endian samples.
The application decompresses the embedded assets into one shared GPU buffer.
Scene uniforms select the crop size, extent, and sample offset for both mesh heights and camera probes.
Both HTML bundles contain all five assets and require no terrain requests at runtime.

## Visual limits

Each mesh uses a local equirectangular approximation centred on its crop.
This approximation has greater distortion across the large Orientale crop.
The renderer applies lunar curvature to the camera-relative mesh.
This view is a regional flyover, not a global globe or navigation instrument.
Terrain outside the crop is not visible. Free flight near the crop boundary can expose its edge.

Elevations have no vertical exaggeration or added procedural craters.
The renderer reconstructs heights with a cubic B-spline across each 4 × 4 sample neighbourhood.
This smooths slopes between source cells and slightly softens peaks without exceeding the local elevation range.
Surface normals and camera clearance use the same reconstructed height field.
Shadow sampling blends adjacent terrain detail levels to reduce abrupt transitions.
The grey regolith colour and fine colour variations are artistic, not measured surface imagery.
The light model includes a small constant bounce-light term for visibility in shadows.
The daylight sky is black, without clouds, atmospheric scattering, stars, or a second Moon.
Each lunar region uses a fixed low Sun. Earth weather and astronomy do not drive these scenes.
Rain, snow, vegetation, water, and the Earth weather widget are absent.
The panel hides Earth-only environment controls during the lunar scene.
The clock still shows the viewer's local time.

## Rebuild the assets

Run the preparation script from the project directory:

```powershell
python tools/prepare-moon.py --all
node build.mjs
```

Without arguments, the script rebuilds Copernicus only.
To rebuild selected regions, pass their names:

```powershell
python tools/prepare-moon.py aristarchus hadley tycho orientale
node build.mjs
```

The script uses the Python standard library. A full uncached rebuild downloads approximately 1.9 GB through HTTP byte ranges.
It checks source sample formats and range responses, then rejects invalid elevation values.
The cache lives under `tools/.moon-cache/`, which Git ignores.
The five compressed JavaScript assets total approximately 9.6 MB. Each self-contained HTML bundle is approximately 10 MB.
The decoded GPU elevation buffer uses approximately 46 MB.

To convert older assets to the current lossless codec without source downloads, run:

```powershell
python tools/prepare-moon.py --all --repack
node build.mjs
```

The repack command preserves the existing elevation samples and their checksums.

## Validation

Run the terrain and route tests:

```powershell
node --test tools/camera-route.test.mjs tools/lunar-terrain.test.mjs
```

Run the Windows integration check:

```powershell
node tools/check-scenes.mjs
```

The check starts its own local server and headless Chrome.
It checks shader errors, each lunar region, both offline bundles, lunar scene transitions, Earth transitions, and route restart.
It saves images under `shots/` for visual inspection.
Set `CHROME_PATH` if Chrome is not installed at its default Windows location.

## Other bodies

Scene metadata carries the body radius, elevation limits, and crop extent.
The height bake and camera probes share one DEM sampling function.
Additional bodies need their own asset and a terrain registry entry.

| Body | Public source | Additional work |
|---|---|---|
| Mars | [USGS MOLA/HRSC 200 m DEM](https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m) | Dusty atmosphere, surface colour, and body-specific lighting |
| Mercury | [USGS MESSENGER 665 m DEM](https://astrogeology.usgs.gov/search/map/mercury_messenger_global_dem_665m) | New terrain crop and solar illumination scale |
| Venus | [USGS Magellan 4.6 km topography](https://astrogeology.usgs.gov/search/map/venus_magellan_global_topography_4641m) | Dense atmosphere and a higher-altitude route for the coarse elevation grid |

These bodies are not selectable scenes in this version.

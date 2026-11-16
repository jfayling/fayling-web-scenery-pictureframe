# Attribution and third-party data

The code in this repository is released under the [MIT License](LICENSE). This file lists the data, research, and media the picture frame relies on, and the terms that apply to them.

## Lunar elevation data (SLDEM2015)

The five lunar regions (Copernicus, Aristarchus Plateau, Hadley–Apennine, Tycho, Orientale) use crops of **SLDEM2015**. It is a lunar digital elevation model that combines Lunar Reconnaissance Orbiter LOLA laser altimetry with SELENE (Kaguya) Terrain Camera stereo data.

- Product page: [NASA Planetary Geodesy Data Archive, product 54](https://pgda.gsfc.nasa.gov/products/54)
- Source tiles: [MIT LOLA archive, SLDEM2015 FLOAT_IMG](https://imbrium.mit.edu/DATA/SLDEM2015/TILES/FLOAT_IMG/)
- Tiles used: `SLDEM2015_256_0N_60N_240_360_FLOAT` (Copernicus, Aristarchus), `SLDEM2015_256_60S_0S_240_360_FLOAT` (Tycho, Orientale), `SLDEM2015_512_00N_30N_000_045_FLOAT` (Hadley)
- **Citation:** Barker, M. K., Mazarico, E., Neumann, G. A., Zuber, M. T., Haruyama, J., and Smith, D. E. (2016). A new lunar digital elevation model from the Lunar Orbiter Laser Altimeter and SELENE Terrain Camera. *Icarus*, 273, 346–355. [doi:10.1016/j.icarus.2015.07.039](https://doi.org/10.1016/j.icarus.2015.07.039)

The bundled assets in `js/moon*-data.js` are downsampled and losslessly re-encoded crops. `tools/prepare-moon.py` generates them, and each file records its source URL, PDS label, bounds, the citation above, and SHA-256 checksums of the source crop and the decoded samples. [Moon terrain](docs/planet-terrain.md) documents the processing.

The archive distributes SLDEM2015 publicly without a separate license file. NASA data is generally not subject to copyright in the United States. The SELENE contribution comes from JAXA. This project credits both missions and cites the paper above, which is the acknowledgement the data producers ask for. If you redistribute the lunar assets separately from this project, keep this attribution with them.

The regolith colour, the lighting, and the fine surface detail are artistic and are not measured imagery.

## Star catalogue

`js/star-catalog.js` is derived from the **Yale Bright Star Catalogue, 5th revised edition** (Hoffleit and Warren, 1991). It is in the public domain.

## Weather and geocoding services

The optional weather widget and place search call these services at runtime. Their data isn't bundled.

- [Open-Meteo](https://open-meteo.com/) forecast and geocoding APIs. Data is licensed under [CC BY 4.0](https://open-meteo.com/en/license).
- [U.S. National Weather Service API](https://www.weather.gov/documentation/services-web-api) for active alerts. It is public domain.

## Rendering techniques

The renderer implements published techniques, including:

- S. Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique," *Computer Graphics Forum* 39(4), 2020, for the sky, transmittance and multiple-scattering LUTs, and aerial perspective.
- F. Strugar, "Continuous Distance-Dependent Level of Detail for Rendering Heightmaps" (CDLOD), *Journal of Graphics, GPU, and Game Tools*, 2009, for the terrain mesh.
- AgX-style display transform for tone mapping.

No third-party code from these works is included.

## Background music

`media/track001.mp3` ("Soft Fiano") and `media/track002.mp3` ("Sustained Open Chord") were added by the repository owner. Their source and license are not yet recorded here.

## Contributors

- Jason Fayling, original project
- Dan Price ([@g051051](https://github.com/g051051)): measured lunar terrain, the Copernicus flyover, four additional lunar regions, and lossless terrain compression

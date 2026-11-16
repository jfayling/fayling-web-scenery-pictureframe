# Browser support

The picture frame renders everything on the GPU with WebGPU and WGSL. There is no WebGL fallback, so it needs a browser and GPU with WebGPU enabled.

## Summary

| Browser | Status |
|---|---|
| Chrome / Edge (desktop, Windows) | **Primary target.** Development, screenshots, and the automated GPU checks all use Chrome on Windows. |
| Chrome / Edge (desktop, macOS, ChromeOS) | Should work where WebGPU is enabled. Not regularly tested. |
| Chrome (desktop, Linux) | WebGPU may be behind a flag or GPU blocklist depending on version and driver. Not tested. |
| Safari | Recent versions ship WebGPU. Not tested; reports welcome. |
| Firefox | WebGPU is shipping on some platforms. Not tested; reports welcome. |
| Mobile browsers | Not a target. The scene is tuned for a large screen and a discrete GPU. |

WebGPU availability changes with each browser release. For the current status, see [caniuse.com/webgpu](https://caniuse.com/webgpu) and the [WebGPU implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) page.

## Requirements

- **A secure context.** WebGPU only works over `https://`, on `http://localhost`, or from a local file (`file://`). The GitHub Pages demo is served over HTTPS.
- **A capable GPU.** The terrain mesh reaches 110 km, and every Earth region draws individual trees. A recent discrete GPU is recommended. Integrated GPUs may run at a low frame rate.
- **No required optional features.** The renderer uses `timestamp-query` and `float32-filterable` when the adapter offers them and works without them. Without `timestamp-query` there is no GPU timing, so the automatic resolution scaling stays off.
- **About 10 MB to load.** The page is one self-contained file that includes the shaders and the compressed lunar elevation data.

## Resolution and frame rate

The drawing target is capped at a 2560 × 1440 pixel budget, and the result is scaled to the display. On GPUs that report timestamps, the frame steps its resolution down when frames run long and back up when there is headroom. **Settings → Scenery → Quality → Render scale** changes the budget (0.5 to 1.5).

The project doesn't publish frame-rate figures, because they depend heavily on the GPU, the display, and the region. To see your own numbers, add `showInfo=true` to the URL. The HUD then shows frame time and GPU time.

## Network use

Rendering needs no network access. The standalone HTML files work offline, including all five lunar regions. Optional features do use the network:

- The **weather widget** and **Follow weather** rain use [Open-Meteo](https://open-meteo.com/) and, for US locations, [api.weather.gov](https://www.weather.gov/documentation/services-web-api) alerts.
- **Place search** for the dynamic sky and weather uses the Open-Meteo geocoding API.
- **Background music** loads `media/track001.mp3` and `media/track002.mp3` relative to the page. Music is off by default.

See [troubleshooting](troubleshooting.md) if the page doesn't start.

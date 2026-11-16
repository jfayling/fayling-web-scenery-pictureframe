# Troubleshooting

## "WebGPU is not available in this browser"

The browser doesn't expose `navigator.gpu`.

1. Use a current desktop Chrome or Edge. See [browser support](browser-support.md).
2. Open the page over `https://`, from `http://localhost`, or as a local file. WebGPU is disabled on plain `http://` from other hosts.
3. Open `chrome://gpu` and look for **WebGPU: Hardware accelerated**. If it says disabled, update your GPU driver. Also make sure **Settings → System → Use graphics acceleration when available** is on.
4. On Linux, WebGPU may need `chrome://flags/#enable-unsafe-webgpu` and, for some drivers, `chrome://flags/#enable-vulkan`. These are experimental browser flags; use them at your own risk.

## "No WebGPU adapter found"

WebGPU is present but no GPU was offered to the page. This usually means the GPU is on the browser's blocklist, the driver is too old, or you're in a virtual machine or remote desktop session without GPU access. Update the driver, then check `chrome://gpu` again.

## It runs on the integrated GPU and is slow

The page asks for the `high-performance` adapter, but on laptops Windows decides which GPU Chrome gets:

1. Open **Settings → System → Display → Graphics**.
2. Add or select **Google Chrome** (or Edge), choose **Options**, then pick **High performance**.
3. Restart the browser completely.

To confirm, add `showInfo=true` to the URL and compare the GPU time before and after.

## Low frame rate

- Lower **Settings → Scenery → Quality → Render scale**.
- Reduce **Forest density** under **Settings → Scenery → Landscape**. Trees are the largest geometry cost.
- Turn off **Rain** if it's on.
- Close other GPU-heavy tabs and applications.
- On a 4K display, the drawing target is already capped at a 1440p budget and scaled up. Raising Render scale above 1 renders closer to native 4K and costs more.

## Black screen, or the loading screen never finishes

- Open DevTools (F12) → **Console** and look for errors. A shader compile error or `init failed` message is a bug; please [open an issue](https://github.com/jfayling/fayling-web-scenery-pictureframe/issues/new?template=bug_report.yml) with the console text and your GPU.
- The first frames bake every terrain level at once, so startup on a slow GPU can take several seconds.
- If the GPU driver resets (the screen flickers and the page goes black), reload the page. Lowering Render scale makes this less likely.

## The settings look wrong after an update

Settings are saved in the browser's local storage. Open **Settings → General → Reset to defaults**, or add a URL parameter to override one setting for a single visit, for example `?forestDensity=0.3`.

## No music

Music is off by default. Press **M** or the **Music** button to turn it on. Browsers only allow audio after you interact with the page, so click or press a key first. When you open a standalone HTML file, the `media/` folder must sit next to it. Without that folder the frame runs silently.

## The weather card shows an error

The weather widget needs network access to Open-Meteo. It's optional: press **F** to hide it, or turn it off under **Settings → Widgets → Weather**. Rendering doesn't depend on it.

## Free flight shows the edge of the Moon terrain

Each lunar region is a measured crop of a few hundred kilometres. Free flight near its edge can show the boundary. Press **P** to return to the autopilot route. See [Moon terrain](planet-terrain.md#visual-limits).

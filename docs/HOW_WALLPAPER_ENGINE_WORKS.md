# How Wallpaper Engine works, and how Astral does the same

These notes come from studying Wallpaper Engine's shipped files: binaries (with REA/Ghidra), its asset folder, and the formats of Workshop items. Wallpaper Engine files were only ever **read**; nothing in its installation or the Workshop folder was changed.

## 1. Living behind the desktop icons

Windows draws the desktop in `Progman` → `SHELLDLL_DefView` (icons). Sending the undocumented message **`0x052C`** to `Progman` makes Explorer create a `WorkerW` window between the icons and the static wallpaper.

- **Windows 10 / early 11:** `WorkerW` is a top-level window behind the one holding `SHELLDLL_DefView`. The wallpaper window is parented into it with `SetParent`.
- **Windows 11 24H2+:** `WorkerW` and `SHELLDLL_DefView` are both children of `Progman`. The wallpaper becomes a child of `Progman` with `WS_EX_LAYERED`, ordered just below `DefView`.

Astral (`src/main/desktop.js`) detects both layouts. It strips caption and frame styles so the window covers every pixel, and re-checks the embedding every few seconds, because Explorer restarts or theme changes can rebuild these windows. When a wallpaper stops, it asks Windows to redraw the normal wallpaper (`SPI_SETDESKWALLPAPER`).

## 2. Processes

| Wallpaper Engine | Astral |
|---|---|
| `wallpaper32/64.exe`: native D3D11 renderer, Media Foundation video, CEF for web wallpapers | Electron main process + GPU process + one renderer per wallpaper (WebGL2, `<video>`, Chromium for web) |
| `wallpaperui.exe` ×6: CEF library UI, kept alive after closing | One UI renderer, **destroyed** when closed |
| Separate helper for audio capture | Audio loopback captured inside the wallpaper's own process |
| — | All widgets share one renderer process |

## 3. Playback rules

Wallpaper Engine polls the foreground window and classifies the situation as focused, maximized or fullscreen. It also checks battery and lock state, and applies run, mute, pause or stop per rule. Astral does the same every 250 ms (`foregroundState` with monitor rectangles and DWM-cloaked checks), and handles each monitor separately. "Stop" destroys the wallpaper window entirely to free its memory. Paused web wallpapers are frozen with Chromium's page-lifecycle API, and idle memory is trimmed with `EmptyWorkingSet`.

## 4. Workshop and Steam

- Steam's install path is read from the registry. Libraries come from `steamapps/libraryfolders.vdf` (KeyValues format, `src/main/vdf.js`), and Wallpaper Engine's install from `appmanifest_431960.acf`.
- Subscribed items live in `steamapps/workshop/content/431960/<id>/`, each with a `project.json` (title, type, preview, properties).
- Browsing uses the public Workshop pages and the `ISteamRemoteStorage/GetPublishedFileDetails` Web API, which needs no key. Subscribing uses the user's own steamcommunity.com session (they sign in themselves inside the app), and Steam then downloads the item.

## 5. Scene wallpapers

### `scene.pkg`
A simple archive: a `PKGV00xx` version string, a file count, then `(name, offset, length)` entries followed by the data (`src/renderer/scene/pkg.js`).

### `.tex` textures
Containers named `TEXV0005` / `TEXI0001` / `TEXB0001–4`, plus `TEXS` sprite-sheet data. Image data may be LZ4-compressed. Formats include RGBA8888, DXT1/3/5, RG88 and R8, or embedded PNG/JPEG. Flags mark nearest-neighbour filtering, clamped UVs, animated sprite sheets and (TEXB0004) video textures. Astral uploads DXT data directly when the GPU supports S3TC and decodes it on the CPU otherwise (`tex.js`).

### `scene.json`
Describes camera, clear colour, bloom and the object list: images, particles, text and sounds. Each object has transforms, visibility, effects (passes of shaders with textures, combos and constants), and values that can be bound to user properties (`{ "user": "name" }`) or SceneScript (`{ "script": "...", "value": ... }`).

### Shaders
Wallpaper Engine shaders are a GLSL/HLSL mix with `#include`, `[COMBO]` annotations and JSON-annotated uniforms, and they rely on implicit int→float conversions. Astral translates them to GLSL ES 3.00 (`shader.js`):
- adds macros (`float2`, `mul`, `frac`, `lerp`, `saturate`, `texSample2D` and others);
- adds overload wrappers for `pow`, `mix`, `step`, `smoothstep`, `mod`, `max`, `min`, `clamp` and `atan`, and renames reserved words;
- turns integer literals into floats, and moves uniforms declared after use to the top;
- defines combos and macros that are used without a definition.

Effects are looked up in the item's pkg first, then in Wallpaper Engine's `assets/` folder (read-only). On this PC, 127 of 134 shaders compile; the rest are skipped without breaking the wallpaper.

### SceneScript
JavaScript modules with `init`, `update`, `cursor*` and `applyUserProperties` hooks, run against `engine`, `thisLayer`, `thisScene`, `shared`, `input` and math classes (`Vec2/3`, `Mat4`). Astral loads Wallpaper Engine's own base classes read-only from its assets folder (with fallbacks) and runs each script in a sandboxed function (`scenescript.js`).

### Rendering
Astral renders each object into an off-screen buffer and runs the effect passes ping-pong style, with named buffers and full-screen capture layers. It then composes the scene and presents it cover-fit with parallax and camera shake. Particles are simulated on the CPU and drawn instanced (`particles.js`, `scene.js`).

## 6. Web wallpapers

These are plain HTML pages. Wallpaper Engine injects `window.wallpaperPropertyListener` (`applyUserProperties`, `applyGeneralProperties`) and `wallpaperRegisterAudioListener` (128 values: 64 bands for each channel). Astral provides the same API from a preload script, feeds it loopback audio, and isolates web wallpapers in their own session partition.

## 7. What is not implemented

- 3D model objects and puppet-warp animation.
- Application (`.exe`) wallpapers, blocked on purpose.
- The wallpaper editor.
- A small number of community effects whose shaders don't translate yet.

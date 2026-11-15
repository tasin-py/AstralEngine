<p align="center"><img src="assets/icon512.png" width="112" alt="Astral Engine icon"></p>

<h1 align="center">Astral Engine</h1>

<p align="center">
Lightweight live wallpapers for Windows. Plays your Steam Workshop scenes, videos and web wallpapers,<br>
with desktop widgets and Rainmeter support, and a familiar dark UI.
</p>

<p align="center">
  <a href="https://www.supportkori.com/tasinpy"><img alt="Buy Me a Coffee" src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-ffdd00?logo=buymeacoffee&logoColor=black"></a>
</p>

---

## Features

**Wallpapers**
- **Steam Workshop:** finds your Steam libraries and subscribed Wallpaper Engine items automatically. Browse, search, filter, subscribe and unsubscribe in the app (Steam downloads the files; Wallpaper Engine must be owned on that Steam account).
- **Scene wallpapers:** native renderer for Wallpaper Engine `scene.pkg` files covering images, effects/shaders, particles, text, sounds, parallax, camera shake, SceneScript and audio response.
- **Video wallpapers:** MP4/WebM/HEVC with hardware decoding, looping, volume and playback rate.
- **Web wallpapers:** HTML wallpapers with the Wallpaper Engine web API (user properties, audio listener).
- **Images**, plus drag-and-drop import of your own files and folders.
- **Multi-monitor:** a different wallpaper per display, or one stretched/cloned across all of them.
- **Playlists:** timer, time-of-day or once-per-login rotation, in order or shuffled.

**Customisation**
- Each wallpaper's own properties (colours, sliders, toggles, combos), with conditions.
- **Built-in display properties for every wallpaper:** volume, playback rate, alignment (cover/fit/stretch), flip, image filter, and colour options (brightness, contrast, saturation, hue).
- **Presets:** save, load, apply to all wallpapers, share as JSON, paste JSON, reset.
- **Desktop widgets:** clock, analog clock, calendar, system monitor, weather, notes, audio visualiser, battery, countdown, photo frame and quotes. They're draggable and lockable, with click-through.
- **Rainmeter:** list, activate and deactivate skins, load layouts, refresh, edit, and install `.rmskin` packages.
- **Taskbar styling:** transparent, blur, acrylic or tinted.

**Performance**
- Pauses, mutes or fully stops wallpapers when another app is focused, maximized or fullscreen, on battery, or when the PC is locked. Each monitor is handled separately.
- FPS limit and render-quality scaling.
- **Feature switches** (Settings › Features): turn off Widgets, Rainmeter, Workshop browsing, Playlists, Taskbar styling or the audio visualiser. A feature that's off is fully unloaded, so it uses no memory, CPU or network.
- Closing the library window frees its memory; wallpapers keep running from the tray.
- Idle memory goes back to Windows while everything is paused.

**App**
- Remembers everything between launches: settings, wallpapers, pause state, window size, library sort and filters.
- **Check for updates** button (Settings › Updates, About, or the tray menu), using GitHub Releases.
- **Buy Me a Coffee** button in Settings › About & Support and in the tray menu.
- Dark installer with a choice of install folder, plus a portable build.

## Resource usage vs Wallpaper Engine

Both apps were measured with the same script (`scripts/bench-processes.ps1`) on the same machine and the same Workshop video. Full data and per-process detail are in [`benchmarks/`](benchmarks/RESULTS.md).

| Scenario | Wallpaper Engine | Astral Engine |
|---|---:|---:|
| Paused (maximized window), wallpaper processes only | 169 MB RAM · 0.08 % CPU | **156 MB RAM · 0.14 % CPU** |
| Paused, everything running in the background¹ | 808 MB RAM · 3.86 % CPU | **156 MB RAM · 0.14 % CPU** |
| Video playing, UI closed | *not measured yet²* | 372 MB RAM · 2.56 % CPU |
| Scene playing, UI closed (self-test) | – | 427 MB RAM · 1.74 % CPU |

¹ Wallpaper Engine keeps its library UI processes alive (6 processes, about 640 MB). Astral destroys its window when you close it.
² Wallpaper Engine paused itself during the measurement because a window was maximized. Run `npm run bench:we` and `npm run bench:astral` with no maximized windows, then `npm run bench:report`.

Honest summary: when paused or idle, Astral uses about the same memory as Wallpaper Engine's core process and far less than Wallpaper Engine with its UI. While playing, Wallpaper Engine's native D3D11 engine is still leaner on RAM than Chromium-based rendering.

## Astral vs Wallpaper Engine: what each can do

| Feature | Wallpaper Engine | Astral |
|---|:---:|:---:|
| Steam Workshop wallpapers (scene / video / web) | ✅ | ✅ |
| Workshop browsing, subscribing | ✅ | ✅ |
| Video wallpapers, hardware decoding | ✅ | ✅ |
| Scene effects & particles | ✅ | ✅ (most shaders; a few community effects are skipped) |
| SceneScript | ✅ | ✅ (common API) |
| 3D models, puppet-warp animation | ✅ | ❌ |
| Application (.exe) wallpapers | ✅ | ❌ (blocked for safety) |
| Built-in props: volume, rate, alignment, flip, filter, colours | ✅ | ✅ |
| Presets (save / load / apply to all / share JSON) | ✅ | ✅ |
| Playlists | ✅ | ✅ |
| Pause/stop rules, per-monitor | ✅ | ✅ |
| Multi-monitor, span, clone | ✅ | ✅ |
| Wallpaper editor | ✅ | ❌ |
| Desktop widgets | ❌ (separate add-ons) | ✅ 11 built in |
| Rainmeter skin manager | ❌ | ✅ |
| Taskbar styling | ❌ | ✅ |
| Feature switches to unload extras | ❌ | ✅ |
| Library UI fully freed when closed | ❌ | ✅ |
| Free & open source | ❌ | ✅ |

Astral reads Wallpaper Engine files **read-only**. It never modifies the Wallpaper Engine installation or your Workshop downloads.

## Install

Download from the [Releases page](https://github.com/tasin-py/AstralEngine/releases/latest):
- **`AstralEngine-Setup-x.y.z.exe`**: installer. You can choose a folder and install for just you or for everyone; it adds Start-menu and desktop shortcuts and an uninstaller.
- **`AstralEngine-Portable-x.y.z.exe`**: runs without installing.

Requirements: Windows 10/11 (64-bit). For Workshop content: Steam with Wallpaper Engine owned and the items subscribed.

## Build from source

```bash
git clone https://github.com/tasin-py/AstralEngine.git
cd AstralEngine
npm install
npm start               # run in development
npm test                # unit tests
npm run selftest        # end-to-end check: UI, every wallpaper type, pause, widgets, resources
npm run dist            # installer + portable exe in dist/
```

Other scripts: `npm run dist:art` redraws the installer artwork. `npm run bench:we`, `npm run bench:astral` and `npm run bench:report` handle benchmarks. `npx electron test/shadercheck/main.js` compiles every scene shader found on this PC.

### Updates

"Check for updates" reads the latest release of [tasin-py/AstralEngine](https://github.com/tasin-py/AstralEngine/releases) (set in `src/main/config.js` as `UPDATE_REPO`; users can override it in Settings › Updates).

To ship an update:
1. Raise `version` in `package.json` (for example `1.0.1`) and run `npm run dist`.
2. Create a GitHub release tagged `v1.0.1` and attach `dist/AstralEngine-Setup-1.0.1.exe` (and the portable exe if you like).
3. Installed copies see the update on their next check, then download and run the installer for the user.

## How it works

See [docs/HOW_WALLPAPER_ENGINE_WORKS.md](docs/HOW_WALLPAPER_ENGINE_WORKS.md) for how desktop embedding, the scene format, textures, shaders and Workshop access work, and how Astral implements each.

## Support

If you like the app: **[Buy Me a Coffee ☕](https://www.supportkori.com/tasinpy)**

## License

MIT. Wallpaper Engine is a product of its respective owners. Astral is an independent project and isn't affiliated with Wallpaper Engine or Valve. Workshop content belongs to its authors.

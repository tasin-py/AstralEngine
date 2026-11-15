# Resource usage: Wallpaper Engine vs Astral Engine

Measured with `scripts/bench-processes.ps1` (same method for both apps: CPU time delta over the window, working set and private memory at the end, GPU = Windows "GPU Engine" counters for the app's PIDs). Regenerate this file with `npm run bench:report`.

| Scenario | App | Processes | CPU % | RAM (working set) | Private memory | GPU % | Measured |
|---|---|---:|---:|---:|---:|---:|---|
| video Bigby paused by maximized window | Wallpaper Engine (everything) | 8 | 3.86 | 808 MB | 664 MB | 0.6 | 2026-11-15 15:54 |
| video Bigby paused by maximized window | Wallpaper Engine (wallpaper only, UI excluded) | 2 | 0.08 | 169 MB | 177 MB | – | |
| video Bigby running | Astral Engine (everything) | 3 | 2.56 | 372 MB | 265 MB | 12.6 | 2026-11-15 15:55 |
| video Bigby paused by maximized window | Astral Engine (everything) | 3 | 0.14 | 156 MB | 238 MB | 0.0 | 2026-11-15 15:57 |

## Like-for-like comparisons

| Scenario | Metric | Wallpaper Engine | Astral Engine | Difference |
|---|---|---:|---:|---:|
| video Bigby paused by maximized window | RAM, everything | 808 MB | 156 MB | -81 % |
| video Bigby paused by maximized window | RAM, wallpaper only | 169 MB | 156 MB | -8 % |
| video Bigby paused by maximized window | CPU, everything | 3.86 % | 0.14 % | -96 % |
| video Bigby paused by maximized window | GPU | 0.56 % | 0.00 % | -100 % |

## Notes

- **Wallpaper Engine — video Bigby paused by maximized window:** WE paused itself (its rule: pause when another app is maximized). UI window open.
- **Astral Engine — video Bigby running:** Playback forced to keep running; UI closed. Wallpaper Engine was paused at the time, so there is no matching WE row yet.
- **Astral Engine — video Bigby paused by maximized window:** Same rule as WE (pause when maximized). Astral UI closed (closing it frees its memory); WE UI was open, so compare the "wallpaper only" row for a fair number.

Raw data: the `*.json` files in this folder (one per run, per-process detail included).

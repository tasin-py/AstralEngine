# Changelog

## 1.2.2

- Uninstaller: "Also uninstall Rainmeter" checkbox (unticked by default). Removes the Rainmeter Astral installed, or runs a normal Rainmeter installation's own uninstaller. Skins in Documents\Rainmeter are kept. A portable Rainmeter inside the Astral folder is always removed with it.
- README: screenshots and a note that Workshop wallpapers need Wallpaper Engine owned and installed.

## 1.2.0

### Wallpapers and displays
- Fixed live wallpapers disappearing on a second monitor: Windows' static wallpaper layer could cover a wallpaper running on another display. Astral now keeps every wallpaper above it.
- Mixed-scaling setups (e.g. 100% + 125%) get correctly sized wallpapers and widgets on every display.
- New "Apply to" picker in the footer (Main display, Display N, All displays). With several monitors, wallpapers go to all displays by default; the choice is remembered.
- Single click selects a wallpaper; double click (or "Apply wallpaper") applies it.
- Cancel and "Remove wallpaper" also work with "All displays".
- Scene layers that use their own material shader (e.g. flow-map animation in "Deep Space") now render correctly instead of showing a flat texture.
- 3D scenes (3D models with a perspective camera) are detected and marked "3D wallpapers are not supported yet" instead of rendering a broken frame.
- Library tiles no longer overlap when the window is resized.

### Steam Workshop
- Discover/Workshop filters with several ticked options now return results (tags are combined the way Steam expects).
- Subscribe/Unsubscribe open the page in the Steam app or your web browser (Settings > Steam & Workshop). No Steam sign-in inside Astral. A "Blank page? Open in browser" button helps when Steam's built-in browser shows an empty page.
- The Steam Web API key moved under "Advanced"; it isn't needed.

### Widgets
- Border options (dashed, solid, none), per widget and for all widgets at once.
- One switch turns all widgets on or off.
- Option to hide the × (remove) button.
- Fonts: every installed Windows font plus 15 bundled open-source fonts.
- Sticky notes: + button for another note, colour palette and custom colour.
- Analog clock: 8 faces. Audio visualizer: 9 styles, gradient/rainbow colours, sensitivity, smoothing, thickness and glow.

### Rainmeter
- On/off switch, drag-and-drop `.rmskin` install, "Find skins" (DeviantArt, VisualSkins).
- One-click Rainmeter install (official signed release, checksum-verified) and uninstall.
- Setting: close Rainmeter when Astral Engine closes.

### Settings and installer
- FPS limit can be typed as a number; mouse wheel moves sliders.
- Update repository link is read-only.
- Installer: white option text, desktop shortcut and start-with-Windows options (ticked by default), pinning tip.
- Uninstaller: "Also uninstall Rainmeter" checkbox (unticked by default). Removes the Rainmeter Astral installed, or runs a normal Rainmeter installation's own uninstaller. Skins in Documents\Rainmeter are kept.
- Open-source licences: About > Open-source licences (THIRD_PARTY_NOTICES.txt ships with the app).

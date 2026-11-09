<h1 align="center">DreamEngine</h1>

<p align="center">
  A unified After Effects workspace for effects, presets, curves, and media
</p>

<p align="center">
  English · <a href="README.md">中文</a>
</p>

<p align="center">
  <a href="https://github.com/yoanx/DreamEngine"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/yoanx/DreamEngine?style=flat-square&amp;logo=github&amp;label=Stars"></a>
  <a href="https://github.com/yoanx/DreamEngine/releases"><img alt="Release" src="https://img.shields.io/github/v/release/yoanx/DreamEngine?include_prereleases&amp;style=flat-square&amp;label=release"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-4c9a52?style=flat-square"></a>
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/platform-Windows-4f6f8f?style=flat-square&amp;logo=windows&amp;logoColor=white">
  <img alt="After Effects 2021+" src="https://img.shields.io/badge/After%20Effects-2021%2B-5f8a74?style=flat-square">
  <img alt="CEP 11" src="https://img.shields.io/badge/CEP-11-6b7f95?style=flat-square">
  <img alt="DreamEngine Hub 0.2.0" src="https://img.shields.io/badge/Hub-0.2.0-6f8f9a?style=flat-square">
  <img alt="DreamEngine Panel 0.2.0" src="https://img.shields.io/badge/Panel-0.2.0-7f9c88?style=flat-square">
</p>

> **Beta status:** DreamEngine targets Windows. The main workflows are validated on After Effects 2021 / CEP 11. Later AE releases have not completed full validation.

## Download and install

Current release: **DreamEngine 0.2.0 / v0.2.0-beta.6**

Download from [GitHub Releases](https://github.com/yoanx/DreamEngine/releases/tag/v0.2.0-beta.6):

- `DreamEngine-Hub-Setup-0.2.0.exe`
- `SHA256SUMS.txt`

Installation:

1. Save your After Effects project and quit AE.
2. Run the installer, choose an installation directory, and finish setup.
3. Start After Effects and open `Window > Extensions > DreamEngine`.

The installer is unsigned, so Windows SmartScreen may show an "Unknown publisher" warning. Upgrades replace application files and built-in preview resources without deleting user presets, categories, favorites, or generated previews.

## Quick start

### AE panel

| Page | Action |
| --- | --- |
| Effects | Search or filter; double-click to add an effect to the selected layer; hover to play animated previews |
| Presets | Click a card to apply an `.ffx` preset; filter by category and favorites |
| Curves | Edit in two-point or multi-point mode; read, reverse, swap, freeze, apply, and save presets |
| Media | Pick a root folder, then browse into subfolders; click a breadcrumb segment to go back; click to preview, double-click to import at the current composition time |

### DreamEngine Hub

Hub is a standalone manager that runs outside the active AE process:

- Add, rename, favorite, categorize, and long-press to delete `.ffx` presets.
- Render offline previews and animated frame sequences for plugin presets.
- Render third-party effect previews one by one in isolated AE instances using the current AE plugin catalog.
- Browse built-in and third-party plugin effects by AE category in the Effects Library; entries without a preview show as pending.
- Clear one preset's previous preview or force a fresh single-preset render.
- Add custom preview backgrounds.
- Inspect panel installation, AE versions, directories, and render logs.

Preset categories and preset favorites are shared between the panel and Hub.

## Features

### DreamEngine Hub

**Preset library**

- Import `.ffx` files through the file picker or drag and drop.
- Create, rename, and delete categories in the left sidebar. Drag the divider to resize the sidebar; double-click it or click "«" to collapse, then use "分类 »" in the toolbar to expand.
- Favorites are an independent filter and can be combined with categories.
- Animated presets play while hovered; static previews show an orange dot in the upper-right corner.
- The context menu provides rename, favorite, skip-render, render-only, delete, and move-to-category actions.
- "Skip render" removes that preset's index and frame files, returns it to the unrendered state, and includes it in the next batch render again.
- Long-press a card or use the context menu to delete its `.ffx` file from the preset library.
- Hub can automatically index `.ffx` files from the selected AE's installed Presets and User Presets folders (index only, no copying) and filter them by source. External AE presets can be selected or rendered individually, but rename/delete only apply to DreamEngine's own preset library. The left sidebar groups external presets by AE source folder (for example Text or Trapcode Tao).

**Effects library**

- Same layout as the preset library: a resizable/collapsible category sidebar, a preview grid with search and source filter, and hover playback.
- Lists built-in effects and the third-party effects from the Plugin Effects catalog together: entries with a preview play on hover, entries without one show a pending placeholder.
- The sidebar groups entries by source (AE Built-in / BCC / Sapphire / Red Giant / RE:Vision / Video Copilot / Other); each group can be expanded or collapsed and the collapsed state is remembered. Categories and groups come from the current AE scan.
- Categories follow the current AE: built-in effects use the localized AE categories from the bilingual name table, plugin effects use the categories from the plugin catalog scan.
- "Sync AE categories" re-scans the plugin effect catalog (scan only, no rendering) and refreshes the categories.

**Offline preview rendering**

- The Plugin Effects page reads the current AE plugin catalog and renders entries in isolated instances with cancellation, resume, and crash blacklisting.
- On the Plugin Effects page you can scan the plugin catalog and select specific effects by plugin, category, or name; only the selected entries are rendered. Enable "force rerender" to render entries that already have previews or were skipped.
- The preset page supports multi-selection and renders only the chosen presets; one click can select all unrendered presets in the current filter.
- Text and animation AE presets (such as AE's built-in Text, Behaviors, and Transitions categories) add no effects. Their previews are applied to a text layer in the composition, or rendered on the built-in Text substrate when no text layer exists, instead of being reported as "failed to apply".
- Plugin presets render in dedicated AE instances to avoid destabilizing the active AE session.
- Each dedicated AE instance handles up to 40 presets by default to reduce repeated launches.
- Save and close AE before rendering. Hub can reopen AE when the job finishes.
- Built-in and custom preview backgrounds are supported.
- "Render only" processes one preset and forces a fresh render, bypassing existing previews and the failure blacklist.

**Settings and diagnostics**

- Inspect Hub, panel, and built-in preview versions.
- Detect installed AE versions and current AE status.
- Open the extension, preset, and log directories.

### AE panel

**Effects**

- Sort by name or category and filter by plugin source.
- Animated previews play on hover; static previews stay still.
- Double-click an effect or use its add button to apply it to the selected layer.
- Favorite effects and combine favorites with category filters.
- Previews prefer the current AE major version and silently fall back to same-name previews from other versions.
- General footage-style effect previews can use a custom background uploaded from Settings.

**Presets**

- Browse imported presets and their previews.
- Click to apply a preset; long-press to delete a preset inside the library.
- Categories and favorites are shared bidirectionally with Hub.
- Animated presets play on hover; static presets show an orange dot.

**Curves**

- Two-point and multi-point curve modes with value, speed, and spatial-path views.
- Double-click to insert nodes, drag nodes and handles, and press Delete/Backspace to remove middle nodes.
- The toolbar can read the current curve, reverse it, swap keyframes, freeze from either side, snap to a 0.1 grid, and undo or redo local graph edits.
- Save custom single-point and multi-point curve presets, and long-press to delete existing presets.
- Multi-keyframe application requires exactly two selected keys and writes only inside that range; user-created middle keys are never overwritten.
- Keyframe signatures are checked before writing to avoid overwriting concurrent edits, and each batch can be undone in one AE undo step.

**Media**

- Register one media root without copying, moving, or modifying source files.
- Browse by folder: open subfolders and step back through the breadcrumb at the top; folder cards show how many materials they contain.
- Category counts and search cover only the folder you are in; empty folders are hidden.
- Refresh and change-root sit in the top-right corner; refreshing keeps your current folder, and if it was deleted the view falls back to the nearest existing parent.
- Automatically classify video, images, audio, and `.aep` projects.
- Click video to preview up to two seconds.
- Audio displays a waveform and can be played or stopped with a click.
- Double-click video, images, or audio to import and place it at the current composition time.
- `.aep` files are imported as projects only; their contents are not parsed or added as media layers.
- Favorite media and combine favorites with category filters.

## Requirements

- Windows 10 or Windows 11
- After Effects 2021 (18.0) or later
- `ffmpeg` is recommended for audio waveforms and cached previews of some video formats

Without `ffmpeg`, core AE workflows still work, but some media previews may be blank.

## Screenshots

**After Effects panel**

![DreamEngine effects panel](assets/screenshots/ae-panel.png)

**DreamEngine Hub**

![DreamEngine Hub](assets/screenshots/hub.png)

## User data

DreamEngine does not upload projects, media, or presets.

| Path | Contents |
| --- | --- |
| `Documents/DreamEngine/presets/` | User `.ffx` presets |
| `Documents/DreamEngine/backgrounds/` | Custom preview backgrounds |
| `Documents/DreamEngine/preset_categories.json` | Preset categories and preset favorites |
| `Documents/DreamEngine/materials/` | Media index, waveform, and video preview cache |
| `Documents/DreamEngineProbe/` | Hub render state and logs |
| `%APPDATA%/Adobe/CEP/extensions/com.dreamengine.panel/` | Installed panel and built-in preview indexes |

Effect favorites, media favorites, curve presets, and some panel preferences remain in the panel's local CEP `localStorage`.

Upgrades preserve presets and caches. Uninstalling DreamEngine from Windows Settings or the Start menu removes the panel scripts, preset library, backgrounds, caches, logs, CEP `localStorage`, and related registry settings. Back up `Documents/DreamEngine/` before uninstalling if you need to keep your presets.

## Troubleshooting

**DreamEngine is missing from the AE menu**

1. Confirm the installer and AE run under the same Windows user.
2. Quit AE completely and start it again.
3. Check the panel installation state and extension directory on Hub's Settings page.

**A plugin preset will not render**

- Save and close every AE instance before starting a Hub render.
- Check Hub's render log and `Documents/DreamEngineProbe/`.
- Confirm the third-party plugins required by the preset are installed.

**Media previews are missing**

- Install `ffmpeg`, or put the absolute path to `ffmpeg.exe` in `Documents/DreamEngine/materials/ffmpeg.txt`.
- Return to the Media page and click Refresh.

## Feedback and contributions

- Use the [Bug report form](https://github.com/yoanx/DreamEngine/issues/new?template=bug_report.yml) for reproducible problems.
- Use the [Feature request form](https://github.com/yoanx/DreamEngine/issues/new?template=feature_request.yml) for workflow proposals.
- Include DreamEngine, Windows, After Effects, and CEP versions, plus relevant logs from `Documents/DreamEngineProbe/`.
- Before opening a PR, follow the PR template and keep secrets, personal paths, and private data out of public content.

## Repository layout

```text
cep/com.dreamengine.panel/   After Effects CEP panel
hub/                         Electron manager
tools/                       PowerShell, ExtendScript, and templates used by Hub and the panel
dist/L1/                     Built-in effect preview resources
assets/screenshots/          README screenshots
```

Before committing `tools/`, check scripts for secrets, personal paths, and private data.

## License

This project is licensed under the [MIT License](LICENSE). You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies, provided the copyright and permission notice is retained.

## Current limitations

- The installer is not code-signed.
- Full validation currently covers AE 2021 / CEP 11.
- Third-party plugin previews depend on the local plugin and licensing environment.
- The media library supports one root folder and requires a manual refresh after disk changes.
- `.aep` contents are not parsed, and project files are not opened automatically.
- Hub and the AE panel do not continuously poll the other process; each view reloads shared state when revisited.

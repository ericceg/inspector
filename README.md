# Inspector

[![Platform](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)]() [![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB.svg)](https://tauri.app) [![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)](https://www.typescriptlang.org)

**Local desktop photo reviewer for fast culling with a locked zoom.** Open a folder, zoom into the detail you care about, then move through the set without resetting the view.

## Why I Made This

When I am reviewing a shoot, I usually care about a very specific region: eyes in a portrait, sharpness on a product edge, motion blur in a hand, or whether two nearly identical frames differ in some small way.

Most photo browsers make that comparison awkward. You zoom in, move to the next image, and lose the exact crop you were checking.

Inspector is built around one idea:

- **Keep the zoom and framing locked** while moving through a folder
- **Cull quickly** with simple pick / hold / reject decisions
- **Compare adjacent frames** without changing your place
- **Stay local** by reviewing directly from a folder on disk

## Features

- **Locked view state**: keep the same zoom and pan while stepping through images
- **Previous-frame compare**: toggle a side-by-side view against the previous image
- **Fast triage**: mark each frame as `pick`, `hold`, or `reject`
- **Filterable filmstrip**: view all frames or only one decision bucket
- **RAW-friendly workflow**: browser-viewable files open directly, RAW files get preview JPEGs
- **Adjustable workspace**: resize or collapse the top bar and both side rails
- **Keyboard-first review**: navigate and rate without leaving the keyboard

## Supported Files

Directly viewable formats:

- `jpg`, `jpeg`, `png`, `tif`, `tiff`, `webp`, `gif`, `avif`, `heic`, `heif`, `bmp`

RAW formats:

- `cr2`, `cr3`, `nef`, `nrw`, `arw`, `sr2`, `orf`, `rw2`, `raf`, `dng`, `pef`, `raw`

RAW previews are currently generated on **macOS** using system tools.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `O` | Open folder |
| `←` `→` | Previous / next frame |
| `H J K L` | Previous / next frame |
| `1` | Pick |
| `2` | Hold |
| `3` | Reject |
| `Backspace` | Reject |
| `U` | Clear current decision |
| `+` / `-` | Zoom in / out |
| `0` | Reset zoom and pan |

## Development

### Prerequisites

- Node.js
- Rust
- Tauri prerequisites for your platform: [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)

### Run Locally

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

## Notes

- This app does not currently persist ratings across sessions.
- RAW preview generation is implemented on macOS; other platforms will not decode RAW files yet.
- Preview JPEGs for RAW files are cached under your system temp directory.

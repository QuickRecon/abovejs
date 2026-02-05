# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

COGViewer is a client-side web application for interactive 3D visualization of Cloud Optimized GeoTIFF (COG) elevation data. It supports desktop viewing with orbit controls and immersive WebXR AR on Meta Quest headsets with hand tracking.

## Running

No build system, bundler, or package manager. All dependencies load via CDN (Three.js r160, GeoTIFF 2.1.3). Serve `index.html` with any static HTTP server (e.g. `python3 -m http.server`). For WebXR AR, HTTPS is required.

There are no tests or linting configured.

## Architecture

### Data Flow

1. User provides a COG file (upload or URL) on the landing page
2. `main.js` orchestrates: parses GeoTIFF, extracts elevation raster, detects NoData/min/max
3. `TerrainMesh` generates a 3D mesh from the elevation grid with GPU shaders, normal maps, and Turbo colormap coloring
4. `ARScene` sets up the Three.js scene, renderer, and camera (desktop or WebXR)
5. `OverlayLayers` optionally generates contour lines via marching squares

### Module Responsibilities (`terrain/`)

- **TerrainMesh.js** (~1750 lines, largest module) — Core mesh generation. Custom GLSL vertex/fragment shaders handle Z-exaggeration via uniforms (no mesh rebuild). Generates normal maps from full-resolution elevation data at up to 4K. Turbo colormap applied as vertex colors.
- **ARScene.js** — Three.js scene lifecycle, renderer setup, desktop OrbitControls, WebXR session rendering loop, pause-drift compensation for `visible-blurred` state.
- **ARManager.js** — WebXR session creation/teardown, feature detection, session event wiring.
- **HandTracking.js** — WebXR hand pose tracking. Detects pinch gestures per-hand and multi-hand compound gestures (drag, scale, rotate, Z-exaggeration).
- **ToolManager.js** — Lifecycle management for AR interaction tools (activate/deactivate/update cycle).
- **HandMenu.js** — Palm-anchored radial menu UI for tool selection in AR.
- **MeasureTool.js / DepthProbeTool.js** — AR interaction tools for distance measurement and elevation probing.
- **OverlayLayers.js** — Contour line generation (marching squares with saddle cases), line simplification, vertex-capped rendering. Syncs with Z-exaggeration changes.
- **LoadingProgress.js** — Loading overlay UI state management.

### Key Files Outside `terrain/`

- **main.js** — Application orchestrator. Handles landing page UI, COG loading, wires terrain mesh to AR scene, manages sidebar controls (Z-exaggeration slider, contour interval, colormap toggles).
- **utils.js** — Turbo colormap lookup table, `processInChunks` for non-blocking iteration.
- **examples.json** — Metadata for bundled example COG datasets.

### Important Patterns

- **Z-exaggeration** is applied in the vertex shader via a uniform, not by rebuilding geometry. Contour overlays must resync when exaggeration changes.
- **NoData handling**: Elevation grids may contain NoData values (often -9999 or similar). These pixels are excluded from min/max analysis and mesh generation.
- **Chunk processing**: Long-running CPU work (mesh generation, contour tracing) uses `processInChunks` to avoid blocking the main thread.
- **WebXR visible-blurred**: When the Quest system menu opens, input poses are blocked by spec and frame rate is throttled. `ARScene` compensates viewer drift to prevent head-locking. See `.claude/webxr-pause-tracking.md` for detailed analysis.
- **Contour vertex budget**: Contour generation caps at 2M vertices to prevent GPU memory issues on complex terrain.

## Context Docs

The `context-docs/` directory contains behavior-focused documentation that doubles as editable specifications. Editing a value or behavior description in these files communicates a desired code change.

| File | Covers |
|------|--------|
| `00-overview.md` | Architecture, module graph, data flows, coordinate spaces, URL params |
| `01-terrain-pipeline.md` | TerrainMesh, OverlayLayers, utils.js (colormap, chunking, disposal) |
| `02-ar-system.md` | ARScene, ARManager, HandTracking, pause compensation, gestures |
| `03-tools-and-menus.md` | ToolManager, HandMenu, MeasureTool, DepthProbeTool, ToolUtils |
| `04-ui-and-loading.md` | Landing page, sidebar controls, LoadingProgress, page transitions |

All concrete values (thresholds, defaults, ranges) are stated inline. When making changes, check the relevant context-doc to understand current behavior and update it to reflect the new behavior.

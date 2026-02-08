# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**abovejs** is a JavaScript library for interactive 3D visualization of Cloud Optimized GeoTIFF (COG) elevation data. It supports desktop viewing with orbit controls and immersive WebXR AR on Meta Quest headsets with hand tracking.

The `examples/cogviewer/` directory contains a complete example application demonstrating library usage.

## Running the Example

No build system, bundler, or package manager. All dependencies load via CDN (Three.js r160, GeoTIFF 2.1.3). Serve from the `examples/cogviewer/` directory with any static HTTP server:

```bash
cd examples/cogviewer
python3 -m http.server
```

For WebXR AR, HTTPS is required.

There are no tests or linting configured.

## Directory Structure

```
abovejs/
├── src/                          # Library source
│   ├── index.js                  # Main exports
│   ├── TerrainViewer.js          # Main orchestrator class
│   ├── core/                     # Core terrain processing
│   │   ├── TerrainMesh.js        # GPU mesh generation, shaders
│   │   ├── OverlayLayers.js      # Contour lines
│   │   ├── COGLoader.js          # GeoTIFF loading
│   │   ├── ElevationAnalysis.js  # Elevation data analysis
│   │   └── utils.js              # Colormap, async chunking
│   ├── scene/                    # Three.js scene management
│   │   ├── ARScene.js            # Renderer, camera, controls
│   │   ├── ARManager.js          # WebXR session lifecycle
│   │   └── utils.js              # Disposal helpers
│   ├── ar/                       # AR/XR interaction
│   │   ├── HandTracking.js       # Hand pose, gestures
│   │   └── HandMenu.js           # Palm-anchored tool menu
│   └── tools/                    # AR interaction tools
│       ├── ToolManager.js        # Tool lifecycle
│       ├── ToolUtils.js          # Shared tool utilities
│       ├── DepthProbeTool.js     # Elevation probing
│       ├── MeasureTool.js        # Distance measurement
│       └── ProfileTool.js        # Elevation profiles
├── examples/
│   └── cogviewer/                # Example application
│       ├── index.html            # Landing page + viewer UI
│       ├── main.js               # UI code using TerrainViewer
│       ├── style.css             # Styling
│       ├── LoadingProgress.js    # Loading overlay component
│       └── examples.json         # Example dataset metadata
├── context-docs/                 # Behavior documentation
├── README.md
├── LICENSE
└── CLAUDE.md
```

## Library API (TerrainViewer)

```javascript
import { TerrainViewer } from './src/index.js';

const viewer = new TerrainViewer('#container', {
  source: 'terrain.tif',       // URL or File object
  enableAR: true,              // Enable AR mode (default: true)
  enableTools: true,           // Enable AR tools (default: true)
  enableContours: true,        // Enable contour lines (default: true)
  terrain: {
    polygons: 1_000_000,       // Target polygon count
    zExaggeration: 4,          // Initial Z exaggeration (1-10)
    normalStrength: 2,         // Normal map strength (0-10)
  },
  contours: {
    interval: 1,               // Contour interval in meters
  },
  onProgress: (stage, percent) => {},
  onReady: (viewer) => {},
  onError: (error) => {},
  onModeChange: (mode) => {},           // 'desktop' | 'ar'
  onZExaggerationChange: (factor) => {},
});

// Runtime methods
viewer.setZExaggeration(5);
viewer.setNormalStrength(3);
viewer.setReferenceElevation(120);
viewer.setContourInterval(2);
viewer.setContourVisibility(false);

// Getters
viewer.getElevationRange();     // { min, max, reference }
viewer.getZExaggeration();
viewer.isContourVisible();

// Mode control
viewer.enterDesktopMode();
viewer.enterARMode();
viewer.isARSupported();
viewer.getMode();               // 'none' | 'desktop' | 'ar'

// Cleanup
viewer.dispose();
```

## Module Responsibilities

### Core (`src/core/`)

- **TerrainMesh.js** (~1750 lines) — GPU mesh generation. Custom GLSL shaders handle Z-exaggeration via uniforms (no mesh rebuild). Generates normal maps at up to 4K. Turbo colormap as vertex colors. Triangle filtering for above-reference areas.
- **OverlayLayers.js** — Contour line generation (marching squares with saddle cases), line simplification, vertex-capped rendering. Auto-syncs with Z-exaggeration.
- **COGLoader.js** — GeoTIFF loading from URL or File, NoData detection, multi-resolution reading.
- **ElevationAnalysis.js** — Min/max/reference elevation analysis.
- **utils.js** — Turbo colormap LUT, `processInChunks` for non-blocking iteration.

### Scene (`src/scene/`)

- **ARScene.js** — Three.js scene lifecycle, renderer setup, desktop OrbitControls, WebXR rendering loop, pause-drift compensation.
- **ARManager.js** — WebXR session creation/teardown, feature detection, mode switching.
- **utils.js** — Three.js object disposal helpers.

### AR (`src/ar/`)

- **HandTracking.js** — WebXR hand pose tracking. Per-hand pinch gestures and compound gestures (drag, scale, rotate, Z-exaggeration).
- **HandMenu.js** — Palm-anchored radial menu for tool selection.

### Tools (`src/tools/`)

- **ToolManager.js** — Tool lifecycle (grab, place, interact, dispose).
- **DepthProbeTool.js** — Elevation and depth display at a point.
- **MeasureTool.js** — Distance measurement between two points.
- **ProfileTool.js** — Elevation profile along a path.

## Important Patterns

- **Z-exaggeration** is applied in the vertex shader via a uniform, not by rebuilding geometry. Contour overlays auto-resync when exaggeration changes.
- **NoData handling**: Elevation grids may contain NoData values (often -9999). These are excluded from analysis and mesh generation.
- **Chunk processing**: Long-running CPU work uses `processInChunks` to avoid blocking the main thread.
- **WebXR visible-blurred**: When Quest system menu opens, `ARScene` compensates viewer drift. See `.claude/webxr-pause-tracking.md`.
- **Contour vertex budget**: Contour generation caps at 2M vertices to prevent GPU memory issues.

## Context Docs

The `context-docs/` directory contains behavior-focused documentation that doubles as editable specifications.

| File | Covers |
|------|--------|
| `00-overview.md` | Architecture, module graph, data flows, coordinate spaces, URL params |
| `01-terrain-pipeline.md` | TerrainMesh, OverlayLayers, utils.js |
| `02-ar-system.md` | ARScene, ARManager, HandTracking, pause compensation, gestures |
| `03-tools-and-menus.md` | ToolManager, HandMenu, MeasureTool, DepthProbeTool, ToolUtils |
| `04-ui-and-loading.md` | Landing page, sidebar controls, LoadingProgress, page transitions |

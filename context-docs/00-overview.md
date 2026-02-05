# Application Overview

This document describes application lifecycle, module relationships, cross-module data flows, coordinate spaces, and the URL parameter system. Values and behaviors stated here are authoritative -- editing a value communicates a desired code change.

---

## Technology Stack

- **Three.js r160** loaded via CDN importmap
- **GeoTIFF 2.1.3** loaded via CDN script tag
- No build system, no bundler, no package manager
- Serve `index.html` with any static HTTP server
- WebXR AR requires HTTPS

---

## Application Lifecycle (Page States)

The application moves through five distinct states:

### 1. Landing

The user is presented with:
- File input (drag/drop or browse)
- URL input field
- Polygon count selector: 500k / 750k / 1M / 1.5M / 2M (default **1M**)
- Contour interval selector: 0.5 / 1 / 2 / 5 / 10 m (default **1 m**)
- Contour toggle (default **on**)
- Example dataset links (each link carries current landing page settings in its href)

### 2. Loading

Six sequential stages with a CSS spinner and progress bar:

1. LOAD_COG
2. CREATE_TERRAIN
3. COMPUTE_COLORS
4. FILTER_GEOMETRY
5. GENERATE_NORMALS
6. CREATE_CONTOURS

### 3. Viewer (Desktop 3D)

Desktop 3D viewport with OrbitControls. Sidebar controls:
- Reference elevation display
- Z-exaggeration slider: range **1--10**, default **4**
- Normal map strength slider: range **0--10**, default **2**
- Contour interval selector
- Contour toggle
- Data info panel
- "Enter AR" and "Load New File" buttons

### 4. AR (WebXR)

Session type: `immersive-ar` (or `immersive-vr` with passthrough on Quest). Provides hand tracking, a palm-anchored radial menu, and interaction tools.

### 5. Disposal

`showLanding()` disposes arManager, terrainMesh, overlayLayers, and toolManager. URL state is cleared.

---

## Module Dependency Graph

```
main.js (orchestrator)
  |-- TerrainMesh.js        mesh generation, contour generation, elevation sampling
  |     \-- utils.js (root)  TURBO_COLORMAP, processInChunks
  |
  |-- OverlayLayers.js      contour line rendering
  |     \-- terrain/utils.js  disposeThreeObject, disposeHierarchy
  |
  |-- ARManager.js           WebXR session lifecycle
  |     \-- ARScene.js        Three.js scene, renderer, camera, controls
  |           \-- terrain/utils.js
  |
  |-- HandTracking.js        pinch gestures, model transforms
  |
  |-- ToolManager.js         tool lifecycle
  |     |-- HandMenu.js      radial menu on hand
  |     |     \-- ToolUtils.js
  |     |-- DepthProbeTool.js
  |     |     \-- ToolUtils.js
  |     |-- MeasureTool.js
  |     |     \-- ToolUtils.js
  |     \-- ToolUtils.js      createTextSprite, worldToLocal, localToWorld,
  |                           clampedElementScale, throttle
  |
  \-- LoadingProgress.js     loading overlay
```

---

## Cross-Module Data Flows

### Elevation data pipeline

COG file or URL
-> GeoTIFF parser
-> Float32Array raster downsampled to approximately 1000 px on the longest side
-> `analyzeElevation()` extracts min, max, noData value, and valid-pixel fraction
-> TerrainMesh receives elevation array and config
-> creates GPU texture, geometry, vertex colors (Turbo colormap), and normal map

In parallel: a full-resolution read at up to **4096 px** is performed for the normal map.

### Z-exaggeration synchronization

Source: the z-exag slider (desktop) or a two-hand vertical pinch gesture (AR).

1. `terrainMesh.setZExaggeration(value)` updates the `heightScale` uniform in the GPU shader (no geometry rebuild).
2. `overlayLayers.updateForZExaggeration()` scales contour line Y coordinates by the old-to-new ratio.
3. The sidebar slider value is updated (relevant when the change originates from an AR gesture).

### Desktop / AR mode transitions

**Entering AR:** `ARManager.enterARMode()` acquires an XR session (requires user gesture), disposes the old desktop scene, creates a new scene, and calls `rebuildSceneContents()` to re-parent the terrain mesh, contour group, and tool groups into the new `modelContainer`.

**Exiting AR:** `ARManager.detachReusableContent()` removes the mesh, contours, and tools from the container before disposal so they survive across the transition. The desktop 3D scene is then rebuilt with the surviving objects.

---

## Coordinate Spaces

### 1. Geographic (CRS)

`geoBounds` is `[minX, minY, maxX, maxY]` from the GeoTIFF. Used for geo-coordinate display in tool readouts.

### 2. Model-local

The terrain mesh is centered at the origin. The longest horizontal dimension equals **1 meter** (`config.modelSize`). Aspect ratio is preserved. The XZ plane is horizontal with Y up. `realWorldScale` = real-world width / model width.

### 3. XR world

WebXR `local-floor` reference space. The model spawns **0.7 m** in front of the camera and **0.2 m** below eye height. `modelContainer.position`, `.rotation`, and `.scale` transform model-local coordinates into XR world coordinates.

---

## URL Parameter System

Supported parameters: `url`, `polygons`, `contours` (1 or 0), `interval`, `zexag` (1--10), `normalScale` (0--10).

### On page load

`applyURLParams()` reads the URL parameters and sets the landing page controls to match. If the `url` parameter is present, the COG is loaded automatically.

### On setting change

`updateBrowserURL()` calls `history.replaceState()` with the current settings, producing a shareable URL that reproduces the viewer state.

### On "Load New File"

URL state is cleared via `history.replaceState(null, '', pathname)`.

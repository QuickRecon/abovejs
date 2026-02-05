# UI and Loading

All UI is defined in `index.html` with no build system. Page state switches between two top-level divs (`#landing` and `#viewer`) plus a full-screen loading overlay and error toast.

---

## Landing Page

### File Input

- Drop zone: click to browse (triggers hidden file input) or drag-and-drop anywhere on the page.
- Accepts `.tif` and `.tiff` files only (validated by regex `/\.tiff?$/i`).
- Drag over: adds `drag-over` class to drop zone for visual feedback.
- Drag leave: removes class only if leaving the document (checks `relatedTarget`).
- Invalid file type shows an error toast: "Please select/drop a .tif or .tiff file".

### URL Input

- Text input with placeholder "Or enter a COG URL...".
- Load button click or Enter key triggers load.
- Empty URL shows an error toast: "Please enter a URL".
- URL is stored in `currentCOGUrl` for shareable URL generation.

### Landing Options

| Option | Element | Choices | Default |
|--------|---------|---------|---------|
| Polygon Count | `<select>` | 500k, 750k, 1M, 1.5M, 2M | 1M (selected) |
| Contour Interval | `<select>` | 0.5 m, 1 m, 2 m, 5 m, 10 m | 1 m (selected) |
| Enable Contours | `<checkbox>` | on/off | checked |

### Example Datasets

Loaded from `examples.json` at startup (fetched async; section hidden if fetch fails). Each example is rendered as a link with the dataset name and a file-size badge.

| Name | File Size |
|------|-----------|
| Wellington | 6.1 MB |
| Stockton | 2.8 MB |
| Swan River | 16 MB |
| Kepwari | 617 KB |
| Logue Brook | 463 KB |

Example links include current landing page settings as URL params (via `buildShareURL`). When polygon count, contour toggle, or contour interval change on the landing page, all example link `href` values are updated.

---

## Loading Overlay (LoadingProgress)

### Structure

Full-screen overlay (`#ar-loading`) containing a CSS spinner, stage text, step counter, progress bar, and percentage display.

### Loading Stages

| # | Key | Display Text |
|---|-----|-------------|
| 1 | LOAD_COG | "Loading COG data" |
| 2 | CREATE_TERRAIN | "Building terrain mesh" |
| 3 | COMPUTE_COLORS | "Computing depth colors" |
| 4 | FILTER_GEOMETRY | "Optimizing geometry" |
| 5 | GENERATE_NORMALS | "Generating lighting" |
| 6 | CREATE_CONTOURS | "Creating contour lines" |

### Behavior

- Shown immediately when `handleLoad()` starts (before COG read begins) for instant user feedback.
- Stage advances via `setStage(key)`: updates stage text with trailing "...", step counter ("Step N of 6"), and resets progress to 0%.
- Progress updated via `setProgress(0-100)`: animates progress bar width and percentage text.
- CSS spinner animation continues even during blocking JavaScript (CSS-only animation).
- Hidden after `buildTerrain()` completes or on error.

### Progress per Stage

| Stage | Progress Source |
|-------|----------------|
| LOAD_COG | Set to 100% after COG data extracted |
| CREATE_TERRAIN | Null progress (indeterminate) |
| COMPUTE_COLORS | 0-100% via `processInChunks` callback, 10,000 vertices per chunk |
| FILTER_GEOMETRY | 0-100% via `processInChunks` callback, 5,000 triangles per chunk |
| GENERATE_NORMALS | 0-100% via `processInChunks` callback, 50 rows per chunk |
| CREATE_CONTOURS | 0-100% per threshold completed |

---

## Viewer Sidebar Controls

### Reference Elevation Slider

- Range: dynamically set to `[floor(minElevation), ceil(maxElevation)]`.
- Step: 0.5.
- Default: `referenceElevation` (equals `maxElevation` from analysis).
- Display format: "{value} m".
- Debounced: 150 ms after last input event.
- On change: updates `referenceElevation`, recalculates `depthRange`, calls `terrainMesh.setElevationConfig` and `terrainMesh.updateReferenceElevation` (recolors vertices, refilters triangles), then regenerates contours (unless vertex limit exceeded).

### Z-Exaggeration Slider

- Range: 1 to 10.
- Step: 0.5.
- Default: 4.0.
- Display format: "{value}x".
- On input (no debounce): calls `terrainMesh.setZExaggeration()`, `overlayLayers.updateForZExaggeration()`, updates browser URL.

### Normal Map Strength Slider

- Range: 0 to 10.
- Step: 0.5.
- Default: 2.0.
- Display format: "{value}".
- On input: calls `terrainMesh.setNormalScale(val)`, updates browser URL.

### Contour Controls

Visible only when contours are enabled.

**Contour Interval** (select): 0.5 m, 1 m (default), 2 m, 5 m, 10 m. On change: regenerates contours with the new interval, updates browser URL.

**Show Contours** (checkbox): checked by default. On change: toggles `overlayLayers.setVisibility('contours', checked)`, updates browser URL. If `contoursExceedLimit` is true, the checkbox is forced unchecked and disabled.

**Limit Note** (`#contour-limit-note`): shown when contour vertex count exceeds 2,000,000. Text: "Contours too numerous -- try reloading with a wider spacing".

### Data Info Section

Displayed after terrain loads. Shows:

- Size (W x H)
- Min elevation (m)
- Max elevation (m)
- Range (m)
- Valid percentage
- NoData value (if present)

### Action Buttons

- **Enter AR**: shown only if `arManager.getARSupported()` returns true. Initiates AR session.
- **Exit AR**: shown during AR session. Detaches content, exits mode, rebuilds desktop 3D.
- **Load New File**: returns to landing page, disposes all resources.

---

## URL Parameter System

### Supported Parameters

| Param | Values | Default | Controls |
|-------|--------|---------|----------|
| url | COG URL string | none | Auto-loads on page load |
| polygons | 500000, 750000, 1000000, 1500000, 2000000 | 1000000 | Polygon count select |
| contours | 0 or 1 | 1 | Contour toggle |
| interval | 0.5, 1, 2, 5, 10 | 1 | Contour interval select |
| zexag | 1-10 (float) | 4 | Z-exaggeration slider |
| normalScale | 0-10 (float) | 2 | Normal map strength slider |

### On Page Load (applyURLParams)

- Reads each param from `URLSearchParams`.
- Validates: `polygons` must match an existing option value; `zexag` clamped to [1, 10]; `normalScale` clamped to [0, 10].
- Applies valid values to corresponding DOM elements.
- If `url` param is present: sets URL input value and triggers auto-load.

### On Setting Change (updateBrowserURL)

- Builds shareable URL from current settings via `buildShareURL()`.
- Calls `history.replaceState()` -- no page navigation, URL bar updates silently.
- Reads contour settings from viewer sidebar if viewer is active, otherwise from landing page.

### On Load New File

- Clears URL: `history.replaceState(null, '', pathname)` -- removes all query params.

---

## Page State Transitions

### Landing to Viewer

1. `showViewer()`: hides `#landing`, shows `#viewer` (flex).
2. Creates `LoadingProgress`, shows overlay.
3. Loads COG data, builds terrain, sets up AR/controls.
4. On error: hides loading overlay, shows error toast (5 seconds), returns to landing.

### Viewer to Landing

1. `showLanding()`: hides `#viewer`, shows `#landing` (flex).
2. Disposes: `arManager`, `terrainMesh`, `overlayLayers`, `toolManager`.
3. Nulls: `handTracking`, `lastContourResult`, `currentCOGUrl`.
4. Clears URL params.
5. Clears `viewer-container` innerHTML.

### Desktop to AR

1. User clicks "Enter AR", which calls `arManager.enterARMode()`.
2. On success: hide Enter AR button, show Exit AR button, `rebuildSceneContents()`.
3. Init hand tracking with new scene references.
4. Init tool manager with scene/camera/modelContainer/terrainMesh/hands.

### AR to Desktop

1. User clicks "Exit AR" or session ends externally.
2. `detachReusableContent` then `exitMode` then `enterDesktop3DMode` then `rebuildSceneContents`.
3. Hide Exit AR button, show Enter AR button.

---

## Error Handling

### Error Toast

- Element: `#error-toast`, hidden by default.
- `showError(message)`: sets text content, shows as block, auto-hides after 5000 ms.
- Used for: file type validation, URL validation, COG load failures.

### Load Failure

- `handleLoad` try/catch: on error, hides loading overlay, shows error toast with message, returns to landing page.

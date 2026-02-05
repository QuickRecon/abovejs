# Terrain Pipeline

Covers: `terrain/TerrainMesh.js`, `terrain/OverlayLayers.js`, `utils.js` (root), `terrain/utils.js`.

---

## COG Data Ingestion

Two reads from the same GeoTIFF image, started in parallel:

1. **Mesh-resolution read** -- Target 1000px on longest side. `scale = min(1, 1000 / max(width, height))`. Output: Float32Array elevation raster at meshWidth x meshHeight.
2. **Normal-map-resolution read** -- Target 4096px on longest side. `normalScale = min(1, 4096 / max(width, height))`. If the computed dimensions match the mesh read, the mesh data is reused (no second read). Output: Float32Array for high-resolution normal map generation.

NoData detection: reads `image.fileDirectory.GDAL_NODATA`, parses as float. Rejected (set to null) if not finite.

---

## Elevation Analysis

Input: mesh-resolution Float32Array + noDataValue.

Skip criteria (per pixel): non-finite values, values >= 1e5, values equal to noDataValue.

Output:
- `minElevation`, `maxElevation`
- `referenceElevation` = maxElevation
- `depthRange` = [0, max(1, round(max - min))]
- `validFraction` = validCount / totalPixels

---

## Mesh Generation Pipeline

### GPU Constraint Check

- Queries `MAX_VERTEX_TEXTURE_IMAGE_UNITS`. If < 1, falls back to CPU vertex displacement for all subsequent operations.
- Queries `MAX_TEXTURE_SIZE` (default assumption 16384 if unchecked). If elevation data exceeds this in either dimension, bilinear downsamples while preserving NoData: any neighbor with NoData in the interpolation neighborhood produces output value 1e38.

### Elevation Texture

Creates a `THREE.DataTexture` from the Float32Array: RedFormat, FloatType, ClampToEdgeWrapping on both axes, NearestFilter for both min and mag (prevents GPU bilinear blending of valid elevation with NoData sentinel values at boundaries).

### Grid Dimensioning

- Computes valid data fraction (non-NoData pixels in the elevation array)
- Target polygon count: default 3,000,000 triangles; configurable on the landing page with options 500k / 750k / 1M / 1.5M / 2M
- `targetQuads = targetPolygons / (2 * validFraction)`
- Derives gridWidth x gridHeight preserving the aspect ratio of the source raster, clamped to [2, elevationWidth] x [2, elevationHeight]

### Geometry Creation

- `THREE.PlaneGeometry(modelWidth, modelHeight, gridWidth - 1, gridHeight - 1)`
- Rotated -90 degrees around the X axis so that XZ becomes the ground plane and Y points up
- Model dimensions: longest side = 1 meter (`config.modelSize`), other side scaled to preserve aspect ratio from geoBounds
- `realWorldScale = realWorldWidth / modelWidth`

### Vertex Coloring (async, chunked at 10,000 vertices per chunk)

For each vertex:
1. Sample elevation via bilinear interpolation at the vertex's UV coordinates (V flipped: `1 - v`)
2. Non-finite elevation or elevation >= referenceElevation: assign gray (0.5, 0.5, 0.5)
3. Below reference: compute `depth = referenceElevation - elevation`, map through Turbo colormap (inverted: shallow = red/yellow, deep = blue/purple)

### Triangle Filtering (async, chunked at 5,000 triangles per chunk)

Pre-pass over all vertices:
- Mark each vertex as NoData if it has any NoData neighbor in its bilinear sampling neighborhood, or if the sampled elevation is non-finite
- Mark each vertex as below-reference if sampled elevation < referenceElevation

Triangle removal rules:
- Any vertex has NoData: triangle removed
- All three vertices are at or above reference (none marked below-reference): triangle removed
- At least one vertex below reference and none with NoData: triangle kept

The original index buffer is preserved for re-filtering when the reference elevation changes.

### Normal Map Generation (async, chunked at 50 rows per chunk)

- Uses the full-resolution elevation data (up to 4096px) when available; falls back to mesh-resolution data on error
- Central differences per pixel: `dzdx = (eR - eL) / (2 * cellSizeX) * strength`, same for Y direction
- `normalMapStrength`: default 5 (in `DEFAULT_CONFIG`)
- NoData neighbors: uses center elevation as fallback
- Normal vector computed as `(-dzdx, -dzdy, 1)`, normalized, then encoded to 0-255 RGB
- NoData pixels: flat normal (128, 128, 255) with alpha 0
- Output: `THREE.CanvasTexture` with mipmaps enabled, `LinearMipmapLinearFilter` + `LinearFilter`, anisotropy 4

### Material and Shaders

**GPU path**: custom `THREE.ShaderMaterial`. Vertex shader samples the elevationMap texture and displaces Y by `(elevation - waterLevel) * heightScale`. Fragment shader discards pixels where elevation >= 1e5 (NoData threshold), applies normal map blending, and computes diffuse lighting.

**CPU fallback**: same fragment shader but the vertex shader takes pre-displaced positions. Vertex positions and geometry normals are computed on the CPU.

Uniform defaults:
- `elevationMap`: the elevation DataTexture
- `waterLevel`: referenceElevation
- `heightScale`: zExaggeration / realWorldScale
- `normalMap`: the generated CanvasTexture
- `normalScale`: 2
- `ambientColor`: (0.3, 0.3, 0.3)
- `lightColor`: (1, 1, 1)
- `lightDirection`: (0.5, 1, 0.5) normalized
- `diffuseStrength`: 0.6

---

## Z-Exaggeration Mechanism

- Range: 1 to 10 (default 4)
- GPU path: updates the `heightScale` uniform to `zExaggeration / realWorldScale`. The vertex shader applies `(elevation - waterLevel) * heightScale`. No mesh rebuild.
- CPU fallback: recalculates all vertex Y positions and recomputes vertex normals
- OverlayLayers sync: `updateForZExaggeration()` scales all contour line Y coordinates by `newExag / lastExag` ratio (no contour regeneration)

---

## Reference Elevation Changes

When the reference elevation slider changes (debounced 150ms):

1. Updates `referenceElevation` and recalculates `depthRange = [0, max(1, round(newRef - minElevation))]`
2. Updates GPU `waterLevel` uniform
3. Recomputes vertex colors (Turbo colormap applied with new depth range) and re-filters triangles (runs in parallel)
4. CPU fallback: also updates all vertex Y positions
5. Regenerates contours unless the vertex limit was previously exceeded (`contoursExceedLimit`)

---

## Contour Generation (in TerrainMesh)

Parameters passed from main.js:
- `referenceElevation`, `minElevation`
- `interval`: contour interval in meters (user-selected)
- `heightOffset`: 0.0008 (normal-direction offset to prevent z-fighting with terrain surface)
- `simplifyTolerance`: 0.0001 (model units, for Douglas-Peucker simplification)
- `maxVertices`: 2,000,000 (abort threshold)

### Threshold Computation

For each depth from `interval` to `round(referenceElevation - minElevation)` stepping by `interval`: compute `ahdLevel = referenceElevation - depth`. Keep the threshold if `ahdLevel >= minElevation`.

### Grid Construction

Samples elevation at grid resolution (gridWidth x gridHeight) using bilinear interpolation. Pre-computes model X/Z coordinate arrays and per-vertex surface normals via central differences (for normal-offset positioning of contour points).

### Marching Squares (per threshold, per cell)

- 16-case edge lookup table. Cases 5 and 10 are saddle cases resolved by the center average of the four corner elevations.
- Corner classification: bit 3 = top-left, bit 2 = top-right, bit 1 = bottom-right, bit 0 = bottom-left. Set if elevation >= threshold.
- Edge interpolation produces [x, z, t] positions on cell edges, where t is the interpolation parameter (used for normal interpolation).
- Normal-offset: each contour point is displaced along the interpolated surface normal by `heightOffset` (0.0008) to prevent z-fighting with the terrain mesh.

### Chain and Simplify (per threshold)

- Builds an adjacency map from segment endpoints using exact float-to-string hash keys (`"x,z"`)
- Walks chains from each unused segment in both directions (forward and backward)
- Applies Douglas-Peucker simplification in 2D (XZ plane only), tolerance = 0.0001 model units
- Emits simplified polylines as line segment pairs

### Vertex Budget

If `totalVertices` exceeds `maxVertices` (2,000,000) during generation, the process aborts immediately and returns `{ aborted: true }`. In main.js: sets `contoursExceedLimit = true`, disables the contour toggle checkbox, and shows a limit note in the UI.

---

## Contour Rendering (OverlayLayers)

- Receives a Float32Array of line segment vertex positions from `TerrainMesh.generateContours()`
- Creates a single `THREE.LineSegments` with `THREE.BufferGeometry` (batched rendering for all thresholds)
- Line color: black (0x000000), `depthTest` enabled
- `contourHeightOffset` in OverlayLayers config: 0.00005 (this is separate from the 0.0008 normal offset used during marching squares generation)
- `contourSimplifyTolerance` in OverlayLayers config: 0.0001 (passed through to TerrainMesh)
- Visibility toggled via `contourGroup.visible`
- Z-exaggeration sync: scales all Y coordinates by `newExag / lastExag` ratio (no regeneration needed)

---

## Turbo Colormap

256-entry lookup table in `utils.js`. Each entry is [r, g, b] in the 0-1 range. QGIS-compatible Turbo spectrum.

Mapping pipeline:
1. Normalize depth to [0, 1] within depthRange: `normalized = (depth - minDepth) / (maxDepth - minDepth)`
2. Clamp to [0, 1]
3. Invert: `inverted = 1 - clamped`
4. Compute fractional index into the 256-entry table: `index = inverted * 255`
5. Linear interpolation between the two nearest table entries

Result: shallow depths map to the red/yellow end of the spectrum; deep values map to blue/purple.

---

## processInChunks Utility

Processes items in chunks, yielding to the event loop between chunks via `setTimeout(resolve, 0)`. Signature: `processInChunks(total, chunkSize, fn, onProgress)`.

Used by:
- Vertex coloring (10,000 items per chunk)
- Triangle filtering (5,000 items per chunk)
- Normal map generation (50 rows per chunk)

Purpose: keeps CSS animations (loading spinner) running during heavy single-threaded CPU work.

---

## Disposal Utilities (terrain/utils.js)

- `disposeThreeObject(object)`: disposes geometry + material (handles material arrays) + all common texture map types (map, normalMap, roughnessMap, metalnessMap, aoMap, emissiveMap, lightMap, bumpMap, displacementMap, envMap, alphaMap)
- `disposeHierarchy(object)`: recursive traverse + `disposeThreeObject` on each child

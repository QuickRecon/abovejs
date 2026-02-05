/**
 * TerrainMesh test factory — instantiates TerrainMesh for testing without
 * needing a renderer, DOM, or GPU.
 */

import { TerrainMesh } from '../../terrain/TerrainMesh.js';

/**
 * Create a TerrainMesh instance ready for testing.
 * @param {{ elevation: Float32Array, width: number, height: number }} grid
 * @param {Object} [options]
 * @param {number[]} [options.geoBounds] - [minX, minY, maxX, maxY], defaults to square
 * @param {number} [options.referenceElevation] - Reference elevation, defaults to grid max
 * @param {number[]} [options.depthRange] - [min, max] depth range
 * @param {number|null} [options.noDataValue] - Explicit NoData value
 * @param {number} [options.targetPolygons] - Target polygon count
 * @returns {TerrainMesh}
 */
export function createTestTerrain(grid, options = {}) {
    const { elevation, width, height } = grid;

    const geoBounds = options.geoBounds ?? [0, 0, width, height];
    const targetPolygons = options.targetPolygons ?? 100000;

    const tm = new TerrainMesh({ targetPolygons });

    // Disable GPU displacement for testing (no renderer)
    tm.useGPUDisplacement = false;

    // Set elevation data
    tm.elevationData = elevation;
    tm.elevationWidth = width;
    tm.elevationHeight = height;
    tm.geoBounds = geoBounds;

    // Calculate dimensions
    tm._calculateModelDimensions(geoBounds);
    tm._calculateGridDimensions = TerrainMesh.prototype._calculateGridDimensions.bind(tm);

    // Compute grid dimensions
    const validFraction = tm._analyzeValidDataFraction();
    const dims = tm._calculateGridDimensions(validFraction);
    tm.gridWidth = dims.gridWidth;
    tm.gridHeight = dims.gridHeight;

    // Set elevation config
    const noDataValue = options.noDataValue ?? null;
    tm.noDataValue = noDataValue;

    // Calculate reference elevation from data if not provided
    let refElev = options.referenceElevation;
    if (refElev === undefined) {
        let max = -Infinity;
        for (let i = 0; i < elevation.length; i++) {
            const v = elevation[i];
            if (Number.isFinite(v) && v < 1e5 && (noDataValue === null || v !== noDataValue)) {
                if (v > max) max = v;
            }
        }
        refElev = max === -Infinity ? 0 : max;
    }

    let min = Infinity;
    for (let i = 0; i < elevation.length; i++) {
        const v = elevation[i];
        if (Number.isFinite(v) && v < 1e5 && (noDataValue === null || v !== noDataValue)) {
            if (v < min) min = v;
        }
    }

    const depthRange = options.depthRange ?? [0, Math.max(1, Math.round(refElev - (min === Infinity ? 0 : min)))];
    tm.setElevationConfig(refElev, depthRange, noDataValue);

    return tm;
}

import { describe, it, expect } from 'vitest';
import { createTestTerrain } from './helpers/terrain-factory.js';
import { slopedGrid, flatGrid, gridWithNoDataHole } from './helpers/elevation-grids.js';

describe('_filterAboveWaterTrianglesAsync', () => {
    it('filtered index count <= original', async () => {
        const grid = slopedGrid(10, 10, 0, 100);
        const tm = createTestTerrain(grid, { referenceElevation: 50, depthRange: [0, 50] });
        tm._createGeometry();
        const originalCount = tm.geometry.index.count;

        await tm._filterAboveWaterTrianglesAsync();
        expect(tm.geometry.index.count).toBeLessThanOrEqual(originalCount);
    });

    it('all indices are valid after filtering', async () => {
        const grid = slopedGrid(10, 10, 0, 100);
        const tm = createTestTerrain(grid, { referenceElevation: 50, depthRange: [0, 50] });
        tm._createGeometry();
        await tm._filterAboveWaterTrianglesAsync();

        const positions = tm.geometry.attributes.position;
        const index = tm.geometry.index;
        for (let i = 0; i < index.count; i++) {
            expect(index.array[i]).toBeLessThan(positions.count);
            expect(index.array[i]).toBeGreaterThanOrEqual(0);
        }
    });

    it('index count is divisible by 3', async () => {
        const grid = slopedGrid(10, 10, 0, 100);
        const tm = createTestTerrain(grid, { referenceElevation: 50, depthRange: [0, 50] });
        tm._createGeometry();
        await tm._filterAboveWaterTrianglesAsync();

        expect(tm.geometry.index.count % 3).toBe(0);
    });

    it('all-valid below-ref: no triangles removed', async () => {
        // All elevations = 10, reference = 100 → all below reference
        const grid = flatGrid(10, 10, 10);
        const tm = createTestTerrain(grid, { referenceElevation: 100, depthRange: [0, 90] });
        tm._createGeometry();
        const originalCount = tm.geometry.index.count;

        await tm._filterAboveWaterTrianglesAsync();
        expect(tm.geometry.index.count).toBe(originalCount);
    });

    it('all-above-ref: all triangles removed', async () => {
        // All elevations = 100, reference = 50 → all above reference
        const grid = flatGrid(10, 10, 100);
        const tm = createTestTerrain(grid, { referenceElevation: 50, depthRange: [0, 1] });
        tm._createGeometry();

        await tm._filterAboveWaterTrianglesAsync();
        expect(tm.geometry.index.count).toBe(0);
    });

    it('NoData triangles are removed', async () => {
        const grid = gridWithNoDataHole(10, 10, 50);
        const tm = createTestTerrain(grid, { referenceElevation: 100, depthRange: [0, 50] });
        tm._createGeometry();
        const originalCount = tm.geometry.index.count;

        await tm._filterAboveWaterTrianglesAsync();
        // Some triangles should be removed due to NoData
        expect(tm.geometry.index.count).toBeLessThan(originalCount);
    });
});

import { describe, it, expect } from 'vitest';
import { createTestTerrain } from './helpers/terrain-factory.js';
import { slopedGrid, gridWithNoDataHole, flatGrid } from './helpers/elevation-grids.js';

describe('_computeVertexColorsAsync', () => {
    it('all RGB values in [0, 1]', async () => {
        const grid = slopedGrid(10, 10, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        await tm._computeVertexColorsAsync();

        const colors = tm.geometry.attributes.color;
        expect(colors).toBeDefined();
        for (let i = 0; i < colors.count; i++) {
            const r = colors.getX(i);
            const g = colors.getY(i);
            const b = colors.getZ(i);
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThanOrEqual(1);
            expect(g).toBeGreaterThanOrEqual(0);
            expect(g).toBeLessThanOrEqual(1);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThanOrEqual(1);
        }
    });

    it('NoData vertices get gray (0.5, 0.5, 0.5)', async () => {
        const grid = gridWithNoDataHole(10, 10, 50);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        await tm._computeVertexColorsAsync();

        const colors = tm.geometry.attributes.color;
        const uvs = tm.geometry.attributes.uv;

        // Find vertices that sample NoData and check they're gray
        for (let i = 0; i < uvs.count; i++) {
            const u = uvs.getX(i);
            const v = 1 - uvs.getY(i);
            const elev = tm._sampleElevation(u, v);
            if (!Number.isFinite(elev)) {
                expect(colors.getX(i)).toBeCloseTo(0.5, 3);
                expect(colors.getY(i)).toBeCloseTo(0.5, 3);
                expect(colors.getZ(i)).toBeCloseTo(0.5, 3);
            }
        }
    });

    it('above-reference vertices get gray', async () => {
        // Set reference to 50, so elevations at 50 and above are gray
        const grid = slopedGrid(10, 10, 0, 100);
        const tm = createTestTerrain(grid, { referenceElevation: 50, depthRange: [0, 50] });
        tm._createGeometry();
        await tm._computeVertexColorsAsync();

        const colors = tm.geometry.attributes.color;
        const uvs = tm.geometry.attributes.uv;

        for (let i = 0; i < uvs.count; i++) {
            const u = uvs.getX(i);
            const v = 1 - uvs.getY(i);
            const elev = tm._sampleElevation(u, v);
            if (Number.isFinite(elev) && elev >= 50) {
                expect(colors.getX(i)).toBeCloseTo(0.5, 3);
                expect(colors.getY(i)).toBeCloseTo(0.5, 3);
                expect(colors.getZ(i)).toBeCloseTo(0.5, 3);
            }
        }
    });

    it('color attribute length = 3 * vertexCount', async () => {
        const grid = slopedGrid(10, 10, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        await tm._computeVertexColorsAsync();

        const colors = tm.geometry.attributes.color;
        const positions = tm.geometry.attributes.position;
        expect(colors.array.length).toBe(positions.count * 3);
    });
});

import { describe, it, expect } from 'vitest';
import { createTestTerrain } from './helpers/terrain-factory.js';
import { flatGrid, slopedGrid, gaussianHill, cone, basin, stepGrid, gridWithNoDataHole } from './helpers/elevation-grids.js';

describe('_buildContourThresholds', () => {
    it('evenly spaced thresholds', () => {
        const tm = createTestTerrain(slopedGrid(10, 10, 0, 100));
        const thresholds = tm._buildContourThresholds(100, 0, 10);
        // Expected: 90, 80, 70, 60, 50, 40, 30, 20, 10 (referenceElevation - depth)
        expect(thresholds.length).toBe(10);
        for (let i = 1; i < thresholds.length; i++) {
            expect(thresholds[i] - thresholds[i - 1]).toBeCloseTo(-10, 5);
        }
    });

    it('thresholds within [min, ref]', () => {
        const tm = createTestTerrain(slopedGrid(10, 10, 20, 80));
        const thresholds = tm._buildContourThresholds(80, 20, 5);
        for (const t of thresholds) {
            expect(t).toBeGreaterThanOrEqual(20);
            expect(t).toBeLessThanOrEqual(80);
        }
    });

    it('empty when interval > range', () => {
        const tm = createTestTerrain(slopedGrid(10, 10, 0, 10));
        const thresholds = tm._buildContourThresholds(10, 0, 20);
        expect(thresholds.length).toBe(0);
    });
});

describe('_buildContourGrid', () => {
    it('dimensions match grid width/height', () => {
        const grid = slopedGrid(15, 12, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const { grid: contourGrid, modelX, modelZ } = tm._buildContourGrid(tm.gridWidth, tm.gridHeight);
        expect(contourGrid.length).toBe(tm.gridWidth * tm.gridHeight);
        expect(modelX.length).toBe(tm.gridWidth);
        expect(modelZ.length).toBe(tm.gridHeight);
    });
});

describe('_interpolateEdge', () => {
    it('position is within cell bounds when threshold crosses the edge', () => {
        const tm = createTestTerrain(slopedGrid(10, 10, 0, 100));
        const bounds = { x0: 0, x1: 1, z0: 0, z1: 1 };

        // Test each edge with corners where threshold=25 actually crosses that edge
        const edgeTests = [
            // edge 0 (top): between tl and tr
            { edge: 0, corners: { tl: 10, tr: 40, br: 50, bl: 20 } },
            // edge 1 (right): between tr and br
            { edge: 1, corners: { tl: 10, tr: 20, br: 30, bl: 15 } },
            // edge 2 (bottom): between bl and br
            { edge: 2, corners: { tl: 10, tr: 15, br: 30, bl: 20 } },
            // edge 3 (left): between tl and bl
            { edge: 3, corners: { tl: 20, tr: 40, br: 50, bl: 30 } },
        ];

        for (const { edge, corners } of edgeTests) {
            const result = tm._interpolateEdge(edge, 25, corners, bounds);
            expect(result[0]).toBeGreaterThanOrEqual(-0.001);
            expect(result[0]).toBeLessThanOrEqual(1.001);
            expect(result[1]).toBeGreaterThanOrEqual(-0.001);
            expect(result[1]).toBeLessThanOrEqual(1.001);
        }
    });

    it('t is in [0, 1] when threshold crosses the edge', () => {
        const tm = createTestTerrain(slopedGrid(10, 10, 0, 100));
        const bounds = { x0: 0, x1: 1, z0: 0, z1: 1 };

        const edgeTests = [
            { edge: 0, corners: { tl: 10, tr: 40, br: 50, bl: 20 } },
            { edge: 1, corners: { tl: 10, tr: 20, br: 30, bl: 15 } },
            { edge: 2, corners: { tl: 10, tr: 15, br: 30, bl: 20 } },
            { edge: 3, corners: { tl: 20, tr: 40, br: 50, bl: 30 } },
        ];

        for (const { edge, corners } of edgeTests) {
            const result = tm._interpolateEdge(edge, 25, corners, bounds);
            expect(result[2]).toBeGreaterThanOrEqual(-0.001);
            expect(result[2]).toBeLessThanOrEqual(1.001);
        }
    });

    it('edge 0 (top) has fixed z=z0', () => {
        const tm = createTestTerrain(slopedGrid(10, 10, 0, 100));
        const corners = { tl: 10, tr: 30, br: 40, bl: 20 };
        const bounds = { x0: 2, x1: 5, z0: 3, z1: 7 };
        const result = tm._interpolateEdge(0, 20, corners, bounds);
        expect(result[1]).toBeCloseTo(3, 5); // z = z0
    });

    it('edge 1 (right) has fixed x=x1', () => {
        const tm = createTestTerrain(slopedGrid(10, 10, 0, 100));
        const corners = { tl: 10, tr: 30, br: 40, bl: 20 };
        const bounds = { x0: 2, x1: 5, z0: 3, z1: 7 };
        const result = tm._interpolateEdge(1, 35, corners, bounds);
        expect(result[0]).toBeCloseTo(5, 5); // x = x1
    });

    it('edge 2 (bottom) has fixed z=z1', () => {
        const tm = createTestTerrain(slopedGrid(10, 10, 0, 100));
        const corners = { tl: 10, tr: 30, br: 40, bl: 20 };
        const bounds = { x0: 2, x1: 5, z0: 3, z1: 7 };
        const result = tm._interpolateEdge(2, 30, corners, bounds);
        expect(result[1]).toBeCloseTo(7, 5); // z = z1
    });

    it('edge 3 (left) has fixed x=x0', () => {
        const tm = createTestTerrain(slopedGrid(10, 10, 0, 100));
        const corners = { tl: 10, tr: 30, br: 40, bl: 20 };
        const bounds = { x0: 2, x1: 5, z0: 3, z1: 7 };
        const result = tm._interpolateEdge(3, 15, corners, bounds);
        expect(result[0]).toBeCloseTo(2, 5); // x = x0
    });
});

describe('generateContours pipeline', () => {
    it('P1: vertexCount is always even, segments.length == vertexCount * 3', async () => {
        const grid = slopedGrid(20, 20, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0, 0);
        expect(result.vertexCount % 2).toBe(0);
        expect(result.segments.length).toBe(result.vertexCount * 3);
    });

    it('P2: no NaN/Inf in segment positions', async () => {
        const grid = slopedGrid(20, 20, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0, 0);
        for (let i = 0; i < result.segments.length; i++) {
            expect(Number.isFinite(result.segments[i])).toBe(true);
        }
    });

    it('P3: aborted==false → vertexCount <= maxVertices', async () => {
        const grid = slopedGrid(20, 20, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const maxV = 500;
        const result = await tm.generateContours(100, 0, 1, 0.0008, null, 0, maxV);
        if (!result.aborted) {
            expect(result.vertexCount).toBeLessThanOrEqual(maxV);
        }
    });

    it('P4: flat grid produces zero segments', async () => {
        const grid = flatGrid(20, 20, 50);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(50, 50, 5, 0.0008, null, 0, 0);
        expect(result.vertexCount).toBe(0);
    });

    it('P5: step grid produces segments along the step boundary', async () => {
        const grid = stepGrid(20, 20, 10, 50);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(50, 10, 5, 0.0008, null, 0, 0);
        expect(result.vertexCount).toBeGreaterThan(0);
    });

    it('gaussian hill produces contour segments', async () => {
        const grid = gaussianHill(30, 30, 100, 0, 5);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0, 0);
        expect(result.vertexCount).toBeGreaterThan(0);
    });

    it('cone produces contour segments', async () => {
        const grid = cone(30, 30, 100, 0);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0, 0);
        expect(result.vertexCount).toBeGreaterThan(0);
    });

    it('basin produces contour segments', async () => {
        const grid = basin(30, 30, 100, 0);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0, 0);
        expect(result.vertexCount).toBeGreaterThan(0);
    });

    it('grid with NoData hole produces segments without NaN', async () => {
        const grid = gridWithNoDataHole(30, 30, 50);
        const tm = createTestTerrain(grid, { referenceElevation: 50, depthRange: [0, 1] });
        tm._createGeometry();
        // Even with NoData the pipeline should not produce NaN
        const result = await tm.generateContours(50, 49, 0.5, 0.0008, null, 0, 0);
        for (let i = 0; i < result.segments.length; i++) {
            expect(Number.isFinite(result.segments[i])).toBe(true);
        }
    });

    it('simplification still produces valid output', async () => {
        const grid = slopedGrid(20, 20, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0.0001, 0);
        expect(result.vertexCount % 2).toBe(0);
        for (let i = 0; i < result.segments.length; i++) {
            expect(Number.isFinite(result.segments[i])).toBe(true);
        }
    });
});

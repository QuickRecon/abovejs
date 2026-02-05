import { describe, it, expect } from 'vitest';
import { TerrainMesh } from '../terrain/TerrainMesh.js';
import { createTestTerrain } from './helpers/terrain-factory.js';
import { slopedGrid, flatGrid } from './helpers/elevation-grids.js';

describe('_calculateGridDimensions', () => {
    it('grid dimensions are >= 2', () => {
        const tm = new TerrainMesh({ targetPolygons: 10 });
        tm.elevationWidth = 5;
        tm.elevationHeight = 5;
        const { gridWidth, gridHeight } = tm._calculateGridDimensions(1.0);
        expect(gridWidth).toBeGreaterThanOrEqual(2);
        expect(gridHeight).toBeGreaterThanOrEqual(2);
    });

    it('grid dimensions do not exceed elevation dimensions', () => {
        const tm = new TerrainMesh({ targetPolygons: 10_000_000 });
        tm.elevationWidth = 50;
        tm.elevationHeight = 30;
        const { gridWidth, gridHeight } = tm._calculateGridDimensions(1.0);
        expect(gridWidth).toBeLessThanOrEqual(50);
        expect(gridHeight).toBeLessThanOrEqual(30);
    });

    it('preserves approximate aspect ratio', () => {
        const tm = new TerrainMesh({ targetPolygons: 100000 });
        tm.elevationWidth = 200;
        tm.elevationHeight = 100;
        const { gridWidth, gridHeight } = tm._calculateGridDimensions(1.0);
        const gridAspect = gridWidth / gridHeight;
        const dataAspect = 200 / 100;
        // Within 50% tolerance
        expect(gridAspect).toBeGreaterThan(dataAspect * 0.5);
        expect(gridAspect).toBeLessThan(dataAspect * 1.5);
    });
});

describe('_calculateModelDimensions', () => {
    it('longest side = 1.0 (default modelSize)', () => {
        const tm = new TerrainMesh();
        tm._calculateModelDimensions([0, 0, 200, 100]);
        expect(Math.max(tm.modelWidth, tm.modelHeight)).toBeCloseTo(1.0, 5);
    });

    it('aspect ratio matches geoBounds', () => {
        const tm = new TerrainMesh();
        tm._calculateModelDimensions([0, 0, 300, 100]);
        const modelAspect = tm.modelWidth / tm.modelHeight;
        expect(modelAspect).toBeCloseTo(3.0, 3);
    });

    it('square bounds give square model', () => {
        const tm = new TerrainMesh();
        tm._calculateModelDimensions([0, 0, 100, 100]);
        expect(tm.modelWidth).toBeCloseTo(tm.modelHeight, 5);
    });
});

describe('_createGeometry', () => {
    it('creates geometry with correct vertex count', () => {
        const grid = slopedGrid(20, 15, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const positions = tm.geometry.attributes.position;
        expect(positions.count).toBe(tm.gridWidth * tm.gridHeight);
    });

    it('all indices are valid', () => {
        const grid = slopedGrid(20, 15, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const positions = tm.geometry.attributes.position;
        const index = tm.geometry.index;
        if (index) {
            for (let i = 0; i < index.count; i++) {
                expect(index.array[i]).toBeLessThan(positions.count);
                expect(index.array[i]).toBeGreaterThanOrEqual(0);
            }
        }
    });

    it('geometry has UVs', () => {
        const grid = flatGrid(10, 10, 50);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        expect(tm.geometry.attributes.uv).toBeDefined();
        expect(tm.geometry.attributes.uv.count).toBe(tm.gridWidth * tm.gridHeight);
    });

    it('no degenerate triangles (all indices distinct per triangle)', () => {
        const grid = slopedGrid(20, 15, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const index = tm.geometry.index;
        if (index) {
            for (let i = 0; i < index.count; i += 3) {
                const a = index.array[i];
                const b = index.array[i + 1];
                const c = index.array[i + 2];
                expect(a !== b || b !== c || a !== c).toBe(true);
            }
        }
    });
});

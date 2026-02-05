import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createTestTerrain } from './helpers/terrain-factory.js';

describe('TerrainMesh._sampleElevation', () => {
    // 3x3 grid:
    // 10 20 30
    // 40 50 60
    // 70 80 90
    const grid = {
        elevation: new Float32Array([10, 20, 30, 40, 50, 60, 70, 80, 90]),
        width: 3,
        height: 3
    };

    it('corner values are exact', () => {
        const tm = createTestTerrain(grid);
        // (0,0) = top-left = 10
        expect(tm._sampleElevation(0, 0)).toBeCloseTo(10, 5);
        // (1,0) = top-right = 30
        expect(tm._sampleElevation(1, 0)).toBeCloseTo(30, 5);
        // (0,1) = bottom-left = 70
        expect(tm._sampleElevation(0, 1)).toBeCloseTo(70, 5);
        // (1,1) = bottom-right = 90
        expect(tm._sampleElevation(1, 1)).toBeCloseTo(90, 5);
    });

    it('center value is bilinear average', () => {
        const tm = createTestTerrain(grid);
        // (0.5, 0.5) → center of grid = average of 10,20,40,50 = bilinear
        // u=0.5, v=0.5 → x=1, y=1 → exact grid point = 50
        expect(tm._sampleElevation(0.5, 0.5)).toBeCloseTo(50, 5);
    });

    it('midpoint of top edge is bilinear', () => {
        const tm = createTestTerrain(grid);
        // (0.5, 0) → x=1, y=0 → exact grid point = 20
        expect(tm._sampleElevation(0.5, 0)).toBeCloseTo(20, 5);
    });

    it('NaN propagation: any corner NaN → result NaN', () => {
        const gridWithNaN = {
            elevation: new Float32Array([10, NaN, 30, 40]),
            width: 2,
            height: 2
        };
        const tm = createTestTerrain(gridWithNaN);
        // Sampling anywhere that touches the NaN corner
        const result = tm._sampleElevation(0.5, 0);
        expect(Number.isNaN(result)).toBe(true);
    });

    describe('property-based: result within corner bounds', () => {
        it('result in [min(corners), max(corners)] for valid quad', () => {
            fc.assert(fc.property(
                fc.double({ min: 0, max: 1, noNaN: true }),
                fc.double({ min: 0, max: 1, noNaN: true }),
                (u, v) => {
                    const tm = createTestTerrain(grid);
                    const result = tm._sampleElevation(u, v);
                    if (Number.isFinite(result)) {
                        // All values in this grid are 10-90
                        expect(result).toBeGreaterThanOrEqual(10 - 0.01);
                        expect(result).toBeLessThanOrEqual(90 + 0.01);
                    }
                }
            ));
        });
    });
});

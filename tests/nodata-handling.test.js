import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { TerrainMesh } from '../src/core/TerrainMesh.js';

describe('TerrainMesh._isNoData', () => {
    it('NaN → true', () => {
        const tm = new TerrainMesh();
        expect(tm._isNoData(NaN)).toBe(true);
    });

    it('Infinity → true', () => {
        const tm = new TerrainMesh();
        expect(tm._isNoData(Infinity)).toBe(true);
    });

    it('-Infinity → true', () => {
        const tm = new TerrainMesh();
        expect(tm._isNoData(-Infinity)).toBe(true);
    });

    it('>= 1e5 → true', () => {
        const tm = new TerrainMesh();
        expect(tm._isNoData(1e5)).toBe(true);
        expect(tm._isNoData(1e6)).toBe(true);
        expect(tm._isNoData(1e38)).toBe(true);
    });

    it('explicit noDataValue → true', () => {
        const tm = new TerrainMesh();
        tm.noDataValue = -9999;
        expect(tm._isNoData(-9999)).toBe(true);
    });

    it('normal values → false', () => {
        const tm = new TerrainMesh();
        expect(tm._isNoData(0)).toBe(false);
        expect(tm._isNoData(100)).toBe(false);
        expect(tm._isNoData(-50)).toBe(false);
        expect(tm._isNoData(99999)).toBe(false);
    });

    it('just below 1e5 → false', () => {
        const tm = new TerrainMesh();
        expect(tm._isNoData(99999.9)).toBe(false);
    });

    describe('property-based', () => {
        it('finite, < 1e5, not noDataValue → false', () => {
            fc.assert(fc.property(
                fc.double({ min: -1e4, max: 9e4, noNaN: true, noDefaultInfinity: true }),
                (value) => {
                    const tm = new TerrainMesh();
                    tm.noDataValue = -9999;
                    if (value !== -9999 && value < 1e5) {
                        expect(tm._isNoData(value)).toBe(false);
                    }
                }
            ));
        });
    });
});

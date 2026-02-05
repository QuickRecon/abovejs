import { describe, it, expect } from 'vitest';
import { TURBO_COLORMAP } from '../utils.js';
import { TerrainMesh } from '../terrain/TerrainMesh.js';

describe('TURBO_COLORMAP table', () => {
    it('has exactly 256 entries', () => {
        expect(TURBO_COLORMAP.length).toBe(256);
    });

    it('each entry is [r, g, b] with values in [0, 1]', () => {
        for (let i = 0; i < TURBO_COLORMAP.length; i++) {
            const entry = TURBO_COLORMAP[i];
            expect(entry).toHaveLength(3);
            for (let c = 0; c < 3; c++) {
                expect(entry[c]).toBeGreaterThanOrEqual(0);
                expect(entry[c]).toBeLessThanOrEqual(1);
            }
        }
    });
});

describe('TerrainMesh._getColorForDepth', () => {
    const tm = new TerrainMesh();

    it('returns RGB values in [0, 1]', () => {
        const depths = [0, 5, 10, 15, 20, 25, 30, 31];
        for (const d of depths) {
            const [r, g, b] = tm._getColorForDepth(d, 0, 31);
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThanOrEqual(1);
            expect(g).toBeGreaterThanOrEqual(0);
            expect(g).toBeLessThanOrEqual(1);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThanOrEqual(1);
        }
    });

    it('depth=min maps to colormap index 255 (inverted=1)', () => {
        // depth=min → normalized=0 → inverted=1 → index=255
        const [r, g, b] = tm._getColorForDepth(0, 0, 31);
        expect(r).toBeCloseTo(TURBO_COLORMAP[255][0], 5);
        expect(g).toBeCloseTo(TURBO_COLORMAP[255][1], 5);
        expect(b).toBeCloseTo(TURBO_COLORMAP[255][2], 5);
    });

    it('depth=max maps to colormap index 0 (inverted=0)', () => {
        // depth=max → normalized=1 → inverted=0 → index=0
        const [r, g, b] = tm._getColorForDepth(31, 0, 31);
        expect(r).toBeCloseTo(TURBO_COLORMAP[0][0], 5);
        expect(g).toBeCloseTo(TURBO_COLORMAP[0][1], 5);
        expect(b).toBeCloseTo(TURBO_COLORMAP[0][2], 5);
    });

    it('clamps values below min depth', () => {
        const [r, g, b] = tm._getColorForDepth(-10, 0, 31);
        // clamped to 0 → inverted=1 → index=255
        expect(r).toBeCloseTo(TURBO_COLORMAP[255][0], 5);
        expect(g).toBeCloseTo(TURBO_COLORMAP[255][1], 5);
        expect(b).toBeCloseTo(TURBO_COLORMAP[255][2], 5);
    });

    it('clamps values above max depth', () => {
        const [r, g, b] = tm._getColorForDepth(100, 0, 31);
        // clamped to 1 → inverted=0 → index=0
        expect(r).toBeCloseTo(TURBO_COLORMAP[0][0], 5);
        expect(g).toBeCloseTo(TURBO_COLORMAP[0][1], 5);
        expect(b).toBeCloseTo(TURBO_COLORMAP[0][2], 5);
    });
});

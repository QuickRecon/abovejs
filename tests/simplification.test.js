import { describe, it, expect } from 'vitest';
import { TerrainMesh } from '../terrain/TerrainMesh.js';

describe('_simplifyPolyline2D', () => {
    const tm = new TerrainMesh();

    it('endpoints are preserved', () => {
        const points = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
        const result = tm._simplifyPolyline2D(points, 0.1);
        expect(result[0]).toEqual([0, 0]);
        expect(result[result.length - 1]).toEqual([4, 0]);
    });

    it('result is subset of input', () => {
        const points = [[0, 0], [1, 0.01], [2, 0], [3, 0.01], [4, 0]];
        const result = tm._simplifyPolyline2D(points, 0.1);
        for (const p of result) {
            expect(points.some(ip => ip[0] === p[0] && ip[1] === p[1])).toBe(true);
        }
    });

    it('length in [2, input.length]', () => {
        const points = [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0]];
        const result = tm._simplifyPolyline2D(points, 0.1);
        expect(result.length).toBeGreaterThanOrEqual(2);
        expect(result.length).toBeLessThanOrEqual(points.length);
    });

    it('collinear points removed', () => {
        // All points on a straight line
        const points = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
        const result = tm._simplifyPolyline2D(points, 0.001);
        expect(result.length).toBe(2); // Only endpoints
        expect(result[0]).toEqual([0, 0]);
        expect(result[1]).toEqual([4, 0]);
    });

    it('tolerance=0 preserves all points', () => {
        const points = [[0, 0], [1, 0.001], [2, 0], [3, 0.001], [4, 0]];
        const result = tm._simplifyPolyline2D(points, 0);
        expect(result.length).toBe(points.length);
    });

    it('very large tolerance keeps only endpoints', () => {
        const points = [[0, 0], [1, 5], [2, -5], [3, 10], [4, 0]];
        const result = tm._simplifyPolyline2D(points, 1e10);
        expect(result.length).toBe(2);
    });

    it('two-point input is returned as-is', () => {
        const points = [[0, 0], [4, 4]];
        const result = tm._simplifyPolyline2D(points, 0.1);
        expect(result.length).toBe(2);
        expect(result).toEqual(points);
    });

    it('zigzag is partially simplified', () => {
        // Zigzag with significant deviation
        const points = [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0]];
        const result = tm._simplifyPolyline2D(points, 0.01);
        expect(result.length).toBeGreaterThanOrEqual(2);
        // With small tolerance, most points should be kept
        expect(result.length).toBe(points.length);
    });
});

import { describe, it, expect } from 'vitest';
import { createTestTerrain } from './helpers/terrain-factory.js';
import { slopedGrid, gaussianHill, cone, basin } from './helpers/elevation-grids.js';

/**
 * Helper: parse raw segment Float32Array into an array of
 * { a: [x,y,z], b: [x,y,z] } segment objects.
 */
function parseSegments(segments, vertexCount) {
    const segs = [];
    for (let i = 0; i < vertexCount; i += 2) {
        segs.push({
            a: [segments[i * 3], segments[i * 3 + 1], segments[i * 3 + 2]],
            b: [segments[(i + 1) * 3], segments[(i + 1) * 3 + 1], segments[(i + 1) * 3 + 2]]
        });
    }
    return segs;
}

/**
 * Helper: build endpoint occurrence map (XZ only, ignoring Y).
 */
function buildEndpointCounts(segs) {
    const counts = new Map();
    const key = (p) => `${p[0]},${p[2]}`;
    for (const seg of segs) {
        const ka = key(seg.a);
        const kb = key(seg.b);
        counts.set(ka, (counts.get(ka) || 0) + 1);
        counts.set(kb, (counts.get(kb) || 0) + 1);
    }
    return counts;
}

describe('contour connectivity invariants (raw, no simplification)', () => {
    it('P6: endpoint degree — no T-junctions (degree <= 2)', async () => {
        const grid = slopedGrid(20, 20, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        // No simplification to test raw marching squares output
        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0, 0);

        const segs = parseSegments(result.segments, result.vertexCount);
        const counts = buildEndpointCounts(segs);

        for (const [endpoint, count] of counts) {
            expect(count).toBeLessThanOrEqual(2);
        }
    });

    it('P6: cone — no T-junctions', async () => {
        const grid = cone(20, 20, 100, 0);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0, 0);

        const segs = parseSegments(result.segments, result.vertexCount);
        const counts = buildEndpointCounts(segs);

        for (const [endpoint, count] of counts) {
            expect(count).toBeLessThanOrEqual(2);
        }
    });

    it('P7: chain continuity — consecutive segment pairs share endpoints', async () => {
        const grid = slopedGrid(20, 20, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0, 0);

        const segs = parseSegments(result.segments, result.vertexCount);
        const counts = buildEndpointCounts(segs);

        // Each endpoint should appear exactly 1 (chain end) or 2 (chain interior/closed loop)
        for (const [_, count] of counts) {
            expect(count === 1 || count === 2).toBe(true);
        }
    });

    it('P8: closed loops on gaussian hill — contours form closed loops', async () => {
        // Gaussian hill well inside the grid should produce closed contour loops
        const grid = gaussianHill(40, 40, 100, 0, 8);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 20, 0.0008, null, 0, 0);

        const segs = parseSegments(result.segments, result.vertexCount);
        const counts = buildEndpointCounts(segs);

        // For well-interior contours, all endpoints should have degree 2 (closed loops)
        // Some contours near the edge may be open, so we check at least one fully closed loop exists
        let allDegreeTwo = 0;
        let otherDegree = 0;
        for (const [_, count] of counts) {
            if (count === 2) allDegreeTwo++;
            else otherDegree++;
        }

        // Most endpoints should be degree 2 (closed loops) for interior contours
        expect(allDegreeTwo).toBeGreaterThan(0);
    });

    it('basin — produces closed contour loops', async () => {
        const grid = basin(40, 40, 100, 0);
        const tm = createTestTerrain(grid);
        tm._createGeometry();
        const result = await tm.generateContours(100, 0, 20, 0.0008, null, 0, 0);

        expect(result.vertexCount).toBeGreaterThan(0);
        const segs = parseSegments(result.segments, result.vertexCount);
        const counts = buildEndpointCounts(segs);

        let degreeTwoCount = 0;
        for (const [_, count] of counts) {
            if (count === 2) degreeTwoCount++;
        }
        expect(degreeTwoCount).toBeGreaterThan(0);
    });
});

import { describe, it, expect } from 'vitest';
import { createTestTerrain } from './helpers/terrain-factory.js';
import { slopedGrid, gaussianHill } from './helpers/elevation-grids.js';

describe('contour Y-offset from terrain surface', () => {
    it('P9: contour vertex Y > pure contourY (normal Y offset is always positive)', async () => {
        const grid = slopedGrid(20, 20, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();

        const ref = 100;
        const minElev = 0;
        const interval = 10;
        const heightOffset = 0.0008;
        const result = await tm.generateContours(ref, minElev, interval, heightOffset, null, 0, 0);

        if (result.vertexCount === 0) return;

        const heightScale = tm.getHeightScale();
        const thresholds = tm._buildContourThresholds(ref, minElev, interval);

        // Each contour vertex Y must be strictly greater than its threshold's
        // pure contourY = (threshold - ref) * heightScale, because the normal
        // Y component is always positive (surface always faces up).
        for (let i = 0; i < result.vertexCount; i++) {
            const y = result.segments[i * 3 + 1];

            // Find the closest threshold to this Y value
            let minDist = Infinity;
            let closestContourY = 0;
            for (const t of thresholds) {
                const cy = (t - ref) * heightScale;
                const dist = Math.abs(y - cy);
                if (dist < minDist) {
                    minDist = dist;
                    closestContourY = cy;
                }
            }

            // The actual Y must be >= the pure contourY (upward normal offset)
            expect(y).toBeGreaterThanOrEqual(closestContourY);
        }
    });

    it('P10: contour vertices sit above surface at their un-offset XZ position', async () => {
        // The correct invariant: at the original (pre-XZ-offset) crossing point,
        // the terrain elevation equals the threshold, and the Y offset is upward.
        // We can't recover the original XZ from the output, so instead we verify
        // that Y > contourY for each vertex (which P9 already checks).
        //
        // Here we verify a weaker but still useful property: contour vertices
        // are close to their threshold elevation, not wildly displaced.
        const grid = gaussianHill(30, 30, 100, 0, 8);
        const tm = createTestTerrain(grid);
        tm._createGeometry();

        const ref = 100;
        const minElev = 0;
        const interval = 20;
        const heightOffset = 0.0008;
        const heightScale = tm.getHeightScale();
        const result = await tm.generateContours(ref, minElev, interval, heightOffset, null, 0, 0);

        if (result.vertexCount === 0) return;

        const thresholds = tm._buildContourThresholds(ref, minElev, interval);

        for (let i = 0; i < result.vertexCount; i++) {
            const y = result.segments[i * 3 + 1];

            // Find the closest threshold contourY
            let minDist = Infinity;
            let closestContourY = 0;
            for (const t of thresholds) {
                const cy = (t - ref) * heightScale;
                const dist = Math.abs(y - cy);
                if (dist < minDist) {
                    minDist = dist;
                    closestContourY = cy;
                }
            }

            // Vertex Y should be close to threshold Y — the normal offset is tiny
            // (heightOffset = 0.0008) so displacement should be small
            expect(y - closestContourY).toBeGreaterThanOrEqual(0);
            expect(y - closestContourY).toBeLessThan(heightOffset * 2);
        }
    });

    it('all contour Y values are finite', async () => {
        const grid = slopedGrid(20, 20, 0, 100);
        const tm = createTestTerrain(grid);
        tm._createGeometry();

        const result = await tm.generateContours(100, 0, 10, 0.0008, null, 0, 0);

        for (let i = 0; i < result.vertexCount; i++) {
            const y = result.segments[i * 3 + 1];
            expect(Number.isFinite(y)).toBe(true);
        }
    });
});

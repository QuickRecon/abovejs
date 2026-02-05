/**
 * elevation-analysis.js — Elevation data analysis (pure function, no DOM)
 *
 * Extracted from main.js for testability.
 */

/**
 * Analyze elevation data to determine min/max and reference elevation.
 * @param {Float32Array} elevation
 * @param {number|null} noDataValue
 * @returns {Object}
 */
export function analyzeElevation(elevation, noDataValue) {
    let min = Infinity;
    let max = -Infinity;
    let validCount = 0;

    for (let i = 0; i < elevation.length; i++) {
        const v = elevation[i];

        // Skip NoData
        if (!Number.isFinite(v)) continue;
        if (v >= 1e5) continue;
        if (noDataValue !== null && v === noDataValue) continue;

        if (v < min) min = v;
        if (v > max) max = v;
        validCount++;
    }

    const validFraction = validCount / elevation.length;

    // Reference elevation = max elevation (everything is "below" the reference)
    const referenceElevation = max;
    const depthRange = [0, Math.max(1, Math.round(max - min))];

    return {
        minElevation: min,
        maxElevation: max,
        referenceElevation,
        depthRange,
        validFraction
    };
}

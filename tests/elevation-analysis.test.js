import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { analyzeElevation } from '../src/core/ElevationAnalysis.js';

describe('analyzeElevation', () => {
    it('ascending values', () => {
        const data = new Float32Array([10, 20, 30, 40, 50]);
        const result = analyzeElevation(data, null);
        expect(result.minElevation).toBe(10);
        expect(result.maxElevation).toBe(50);
        expect(result.referenceElevation).toBe(50);
        expect(result.depthRange[0]).toBe(0);
        expect(result.depthRange[1]).toBe(40);
        expect(result.validFraction).toBe(1);
    });

    it('constant values', () => {
        const data = new Float32Array([5, 5, 5, 5]);
        const result = analyzeElevation(data, null);
        expect(result.minElevation).toBe(5);
        expect(result.maxElevation).toBe(5);
        expect(result.depthRange[1]).toBe(1); // Math.max(1, ...)
    });

    it('skips NaN values', () => {
        const data = new Float32Array([10, NaN, 30, NaN, 50]);
        const result = analyzeElevation(data, null);
        expect(result.minElevation).toBe(10);
        expect(result.maxElevation).toBe(50);
        expect(result.validFraction).toBeCloseTo(3 / 5);
    });

    it('skips Infinity values', () => {
        const data = new Float32Array([10, Infinity, -Infinity, 30]);
        const result = analyzeElevation(data, null);
        expect(result.minElevation).toBe(10);
        expect(result.maxElevation).toBe(30);
        expect(result.validFraction).toBe(0.5);
    });

    it('skips values >= 1e5', () => {
        const data = new Float32Array([5, 100000, 200000, 15]);
        const result = analyzeElevation(data, null);
        expect(result.minElevation).toBe(5);
        expect(result.maxElevation).toBe(15);
        expect(result.validFraction).toBe(0.5);
    });

    it('skips explicit noDataValue', () => {
        const data = new Float32Array([5, -9999, 15, -9999]);
        const result = analyzeElevation(data, -9999);
        expect(result.minElevation).toBe(5);
        expect(result.maxElevation).toBe(15);
        expect(result.validFraction).toBe(0.5);
    });

    it('handles negative elevations', () => {
        const data = new Float32Array([-100, -50, -10]);
        const result = analyzeElevation(data, null);
        expect(result.minElevation).toBe(-100);
        expect(result.maxElevation).toBe(-10);
        expect(result.referenceElevation).toBe(-10);
        expect(result.depthRange[1]).toBe(90);
    });

    it('single element', () => {
        const data = new Float32Array([42]);
        const result = analyzeElevation(data, null);
        expect(result.minElevation).toBe(42);
        expect(result.maxElevation).toBe(42);
        expect(result.validFraction).toBe(1);
    });

    it('all NoData returns Infinity/-Infinity', () => {
        const data = new Float32Array([NaN, NaN, NaN]);
        const result = analyzeElevation(data, null);
        expect(result.minElevation).toBe(Infinity);
        expect(result.maxElevation).toBe(-Infinity);
        expect(result.validFraction).toBe(0);
    });

    describe('property-based tests', () => {
        it('min <= max for valid data', () => {
            fc.assert(fc.property(
                fc.float32Array({
                    minLength: 1,
                    maxLength: 200,
                    min: -500,
                    max: 9000,
                    noNaN: true,
                    noDefaultInfinity: true
                }),
                (data) => {
                    const result = analyzeElevation(data, null);
                    if (result.validFraction > 0) {
                        expect(result.minElevation).toBeLessThanOrEqual(result.maxElevation);
                    }
                }
            ));
        });

        it('referenceElevation == maxElevation', () => {
            fc.assert(fc.property(
                fc.float32Array({
                    minLength: 1,
                    maxLength: 200,
                    min: -500,
                    max: 9000,
                    noNaN: true,
                    noDefaultInfinity: true
                }),
                (data) => {
                    const result = analyzeElevation(data, null);
                    expect(result.referenceElevation).toBe(result.maxElevation);
                }
            ));
        });

        it('depthRange[0] == 0', () => {
            fc.assert(fc.property(
                fc.float32Array({
                    minLength: 1,
                    maxLength: 200,
                    min: -500,
                    max: 9000,
                    noNaN: true,
                    noDefaultInfinity: true
                }),
                (data) => {
                    const result = analyzeElevation(data, null);
                    expect(result.depthRange[0]).toBe(0);
                }
            ));
        });

        it('depthRange[1] >= 1', () => {
            fc.assert(fc.property(
                fc.float32Array({
                    minLength: 1,
                    maxLength: 200,
                    min: -500,
                    max: 9000,
                    noNaN: true,
                    noDefaultInfinity: true
                }),
                (data) => {
                    const result = analyzeElevation(data, null);
                    expect(result.depthRange[1]).toBeGreaterThanOrEqual(1);
                }
            ));
        });

        it('validFraction in [0, 1]', () => {
            fc.assert(fc.property(
                fc.array(
                    fc.oneof(
                        { weight: 4, arbitrary: fc.double({ min: -500, max: 9000, noNaN: true, noDefaultInfinity: true }) },
                        { weight: 1, arbitrary: fc.constant(NaN) }
                    ),
                    { minLength: 1, maxLength: 200 }
                ),
                (values) => {
                    const data = new Float32Array(values);
                    const result = analyzeElevation(data, null);
                    expect(result.validFraction).toBeGreaterThanOrEqual(0);
                    expect(result.validFraction).toBeLessThanOrEqual(1);
                }
            ));
        });
    });
});

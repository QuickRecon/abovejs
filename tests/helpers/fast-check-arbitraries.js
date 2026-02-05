/**
 * Custom fast-check arbitraries for property-based testing.
 */

import fc from 'fast-check';

/** Grid dimensions: width and height between 2 and 100. */
export const gridDimensions = fc.record({
    width: fc.integer({ min: 2, max: 100 }),
    height: fc.integer({ min: 2, max: 100 })
});

/** Random elevation grid with valid finite values. */
export const elevationGrid = gridDimensions.chain(({ width, height }) =>
    fc.float32Array({
        minLength: width * height,
        maxLength: width * height,
        min: -500,
        max: 9000,
        noNaN: true,
        noDefaultInfinity: true
    }).map(elevation => ({ elevation, width, height }))
);

/** Random elevation grid with ~20% NaN values. */
export const elevationGridWithNoData = gridDimensions.chain(({ width, height }) =>
    fc.array(
        fc.oneof(
            { weight: 4, arbitrary: fc.double({ min: -500, max: 9000, noNaN: true, noDefaultInfinity: true }) },
            { weight: 1, arbitrary: fc.constant(NaN) }
        ),
        { minLength: width * height, maxLength: width * height }
    ).map(values => ({
        elevation: new Float32Array(values),
        width,
        height
    }))
);

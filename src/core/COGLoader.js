/**
 * COGLoader.js - Cloud Optimized GeoTIFF loading utilities
 *
 * Extracts elevation data from COG files for terrain visualization.
 */

/**
 * Load a COG from a URL.
 * @param {string} url
 * @returns {Promise<Object>} { elevation, width, height, geoBounds, noDataValue, fullResElevationPromise }
 */
export async function loadCOGFromUrl(url) {
    const tiff = await GeoTIFF.fromUrl(url);
    return await extractCOGData(tiff);
}

/**
 * Load a COG from a File object.
 * @param {File} file
 * @returns {Promise<Object>}
 */
export async function loadCOGFromFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    return await extractCOGData(tiff);
}

/**
 * Extract elevation data from a GeoTIFF.
 * @param {GeoTIFF} tiff
 * @param {Object} [options]
 * @param {number} [options.maxMeshDim=1000] - Maximum mesh dimension
 * @param {number} [options.maxNormalDim=4096] - Maximum normal map dimension
 * @returns {Promise<Object>}
 */
export async function extractCOGData(tiff, options = {}) {
    const { maxMeshDim = 1000, maxNormalDim = 4096 } = options;

    const image = await tiff.getImage();

    const width = image.getWidth();
    const height = image.getHeight();
    const geoBounds = image.getBoundingBox(); // [minX, minY, maxX, maxY]

    // Get NoData value from metadata
    let noDataValue = null;
    const fileDirectory = image.fileDirectory;
    if (fileDirectory.GDAL_NODATA !== undefined) {
        noDataValue = parseFloat(fileDirectory.GDAL_NODATA);
        if (!Number.isFinite(noDataValue)) noDataValue = null;
    }

    // Detect if source data is float16 (BitsPerSample=16, SampleFormat=3)
    // Float16 has limited precision, so noDataValue like -9999 may be stored as -10000
    const isFloat16 = fileDirectory.BitsPerSample?.[0] === 16 &&
                      fileDirectory.SampleFormat?.[0] === 3;

    // Read at a reduced resolution for the mesh (target ~1000px on longest side)
    const scale = Math.min(1, maxMeshDim / Math.max(width, height));
    const meshWidth = Math.round(width * scale);
    const meshHeight = Math.round(height * scale);

    console.log(`COG: ${width}x${height}, reading mesh at ${meshWidth}x${meshHeight}`);
    console.log(`Bounds: [${geoBounds.map(b => b.toFixed(2)).join(', ')}]`);
    if (noDataValue !== null) console.log(`NoData: ${noDataValue}`);

    const rasters = await image.readRasters({
        width: meshWidth,
        height: meshHeight,
        interleave: false
    });
    const elevation = new Float32Array(rasters[0]);

    // For float16 data, the noDataValue from metadata may not match the actual
    // stored value due to precision loss (e.g., -9999 -> -10000). Find the actual
    // value in the raster that's close to the metadata noDataValue.
    if (noDataValue !== null && isFloat16) {
        const tolerance = Math.max(1, Math.abs(noDataValue) * 0.002); // ~0.2% or at least 1
        for (let i = 0; i < Math.min(10000, elevation.length); i++) {
            const v = elevation[i];
            if (Number.isFinite(v) && Math.abs(v - noDataValue) <= tolerance && v !== noDataValue) {
                console.log(`NoData precision adjustment (float16): ${noDataValue} -> ${v}`);
                noDataValue = v;
                break;
            }
        }
    }

    // Start full-res read in parallel for normal map generation
    const fullResElevationPromise = (async () => {
        // For normal map, use up to 4096px on longest side
        const normalScale = Math.min(1, maxNormalDim / Math.max(width, height));
        const normalWidth = Math.round(width * normalScale);
        const normalHeight = Math.round(height * normalScale);

        if (normalWidth === meshWidth && normalHeight === meshHeight) {
            // Same resolution, reuse
            return { elevation, width: meshWidth, height: meshHeight };
        }

        console.log(`Reading full-res for normals: ${normalWidth}x${normalHeight}`);
        const fullRasters = await image.readRasters({
            width: normalWidth,
            height: normalHeight,
            interleave: false
        });
        return {
            elevation: new Float32Array(fullRasters[0]),
            width: normalWidth,
            height: normalHeight
        };
    })();

    return {
        elevation,
        width: meshWidth,
        height: meshHeight,
        geoBounds,
        noDataValue,
        fullResElevationPromise
    };
}

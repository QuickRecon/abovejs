/**
 * Synthetic elevation grid factories for testing.
 * Each returns { elevation: Float32Array, width, height }.
 */

/** Uniform elevation grid. */
export function flatGrid(w, h, elev) {
    const elevation = new Float32Array(w * h).fill(elev);
    return { elevation, width: w, height: h };
}

/** Linear gradient from minElev (left) to maxElev (right). */
export function slopedGrid(w, h, minElev, maxElev) {
    const elevation = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            elevation[y * w + x] = minElev + (maxElev - minElev) * (x / (w - 1));
        }
    }
    return { elevation, width: w, height: h };
}

/** Smooth radial gaussian peak centered in the grid. */
export function gaussianHill(w, h, peak, base, sigma) {
    const elevation = new Float32Array(w * h);
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const dy = y - cy;
            const distSq = dx * dx + dy * dy;
            elevation[y * w + x] = base + (peak - base) * Math.exp(-distSq / (2 * sigma * sigma));
        }
    }
    return { elevation, width: w, height: h };
}

/** Linear radial peak (cone shape). */
export function cone(w, h, peak, base) {
    const elevation = new Float32Array(w * h);
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const maxR = Math.sqrt(cx * cx + cy * cy);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const r = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
            elevation[y * w + x] = peak - (peak - base) * Math.min(1, r / maxR);
        }
    }
    return { elevation, width: w, height: h };
}

/** Concave bowl (basin). */
export function basin(w, h, rim, bottom) {
    const elevation = new Float32Array(w * h);
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const maxR = Math.sqrt(cx * cx + cy * cy);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const r = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
            elevation[y * w + x] = bottom + (rim - bottom) * Math.min(1, r / maxR);
        }
    }
    return { elevation, width: w, height: h };
}

/** Left half low, right half high. */
export function stepGrid(w, h, low, high) {
    const elevation = new Float32Array(w * h);
    const mid = Math.floor(w / 2);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            elevation[y * w + x] = x < mid ? low : high;
        }
    }
    return { elevation, width: w, height: h };
}

/** Grid with a rectangular NaN hole in the center. */
export function gridWithNoDataHole(w, h, elev, noDataVal) {
    const elevation = new Float32Array(w * h).fill(elev);
    const x0 = Math.floor(w * 0.3);
    const x1 = Math.floor(w * 0.7);
    const y0 = Math.floor(h * 0.3);
    const y1 = Math.floor(h * 0.7);
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            elevation[y * w + x] = noDataVal !== undefined ? noDataVal : NaN;
        }
    }
    return { elevation, width: w, height: h };
}

/** Grid with NaN border of given width. */
export function gridWithNoDataBorder(w, h, elev, borderWidth) {
    const elevation = new Float32Array(w * h).fill(elev);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (x < borderWidth || x >= w - borderWidth || y < borderWidth || y >= h - borderWidth) {
                elevation[y * w + x] = NaN;
            }
        }
    }
    return { elevation, width: w, height: h };
}

/** All NaN grid. */
export function allNoDataGrid(w, h) {
    const elevation = new Float32Array(w * h).fill(NaN);
    return { elevation, width: w, height: h };
}

/** 1x1 grid with a single elevation value. */
export function singlePixelGrid(elev) {
    return { elevation: new Float32Array([elev]), width: 1, height: 1 };
}

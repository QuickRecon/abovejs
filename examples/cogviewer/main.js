/**
 * main.js — COG Terrain Viewer example application
 *
 * Demonstrates usage of the abovejs TerrainViewer library.
 * Handles all UI (landing page, sliders, buttons) while the library
 * manages the 3D visualization, AR, and hand tracking.
 */

import { TerrainViewer } from '../../src/index.js';
import { LoadingProgress } from './LoadingProgress.js';

// ============================================
// State
// ============================================

let viewer = null;
let loadingProgress = null;
let currentCOGUrl = null;

// ============================================
// UI Helpers
// ============================================

/**
 * Show an error toast.
 * @param {string} message
 */
function showError(message) {
    const toast = document.getElementById('error-toast');
    toast.textContent = message;
    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 5000);
}

/**
 * Transition from landing to viewer state.
 */
function showViewer() {
    document.getElementById('landing').style.display = 'none';
    document.getElementById('viewer').style.display = 'flex';
}

/**
 * Transition from viewer back to landing state.
 */
function showLanding() {
    document.getElementById('viewer').style.display = 'none';
    document.getElementById('landing').style.display = 'flex';

    // Clean up viewer
    if (viewer) {
        viewer.dispose();
        viewer = null;
    }

    currentCOGUrl = null;
    history.replaceState(null, '', window.location.pathname);

    // Clear the viewer container
    const container = document.getElementById('viewer-container');
    container.innerHTML = '';
}

/**
 * Update slider ranges based on analyzed elevation data.
 */
function updateControlsFromData() {
    const info = viewer.getElevationInfo();
    const refSlider = document.getElementById('ref-elevation-slider');
    const refValue = document.getElementById('ref-elevation-value');

    refSlider.min = Math.floor(info.minElevation);
    refSlider.max = Math.ceil(info.maxElevation);
    refSlider.value = info.referenceElevation;
    refValue.textContent = `${info.referenceElevation.toFixed(1)} m`;
}

/**
 * Update data info display.
 */
function updateDataInfo() {
    const info = viewer.getElevationInfo();
    const infoEl = document.getElementById('data-info');
    infoEl.innerHTML = `
        <p>Size: ${info.width} x ${info.height}</p>
        <p>Min: ${info.minElevation.toFixed(2)} m</p>
        <p>Max: ${info.maxElevation.toFixed(2)} m</p>
        <p>Range: ${info.depthRange[1]} m</p>
        <p>Valid: ${(info.validFraction * 100).toFixed(1)}%</p>
        ${info.noDataValue !== null ? `<p>NoData: ${info.noDataValue}</p>` : ''}
    `;
}

/**
 * Update contour UI state based on viewer state.
 */
function updateContourUI() {
    const contourToggle = document.getElementById('contour-toggle');
    const limitNote = document.getElementById('contour-limit-note');

    if (viewer.contoursExceededLimit()) {
        contourToggle.checked = false;
        contourToggle.disabled = true;
        limitNote.style.display = 'block';
    } else {
        contourToggle.disabled = false;
        limitNote.style.display = 'none';
        contourToggle.checked = viewer.isContourVisible();
    }
}

// ============================================
// URL Parameters
// ============================================

/**
 * Read settings from URL search params and apply to landing page controls.
 * @returns {URLSearchParams}
 */
function applyURLParams() {
    const params = new URLSearchParams(window.location.search);

    if (params.has('polygons')) {
        const el = document.getElementById('polygon-count');
        const val = params.get('polygons');
        if ([...el.options].some(o => o.value === val)) el.value = val;
    }
    if (params.has('contours')) {
        document.getElementById('landing-contour-toggle').checked = params.get('contours') !== '0';
    }
    if (params.has('interval')) {
        const el = document.getElementById('landing-contour-interval');
        const val = params.get('interval');
        if ([...el.options].some(o => o.value === val)) el.value = val;
    }
    if (params.has('zexag')) {
        const val = parseFloat(params.get('zexag'));
        if (val >= 1 && val <= 10) {
            document.getElementById('z-exag-slider').value = val;
            document.getElementById('z-exag-value').textContent = `${val.toFixed(1)}x`;
        }
    }
    if (params.has('normalScale')) {
        const val = parseFloat(params.get('normalScale'));
        if (val >= 0 && val <= 10) {
            document.getElementById('normal-strength-slider').value = val;
            document.getElementById('normal-strength-value').textContent = `${val.toFixed(1)}`;
        }
    }

    return params;
}

/**
 * Build a shareable URL from the current COG URL and settings.
 * @param {string} cogUrl
 * @returns {string}
 */
function buildShareURL(cogUrl) {
    const params = new URLSearchParams();
    params.set('url', cogUrl);
    params.set('polygons', document.getElementById('polygon-count').value);

    const viewerActive = document.getElementById('viewer').style.display !== 'none';
    if (viewerActive) {
        params.set('contours', document.getElementById('contour-toggle').checked ? '1' : '0');
        params.set('interval', document.getElementById('contour-interval').value);
    } else {
        params.set('contours', document.getElementById('landing-contour-toggle').checked ? '1' : '0');
        params.set('interval', document.getElementById('landing-contour-interval').value);
    }
    params.set('zexag', document.getElementById('z-exag-slider').value);
    params.set('normalScale', document.getElementById('normal-strength-slider').value);
    return `${window.location.pathname}?${params}`;
}

/**
 * Update browser URL bar without navigation.
 * @param {string} cogUrl
 */
function updateBrowserURL(cogUrl) {
    if (!cogUrl) return;
    const shareURL = buildShareURL(cogUrl);
    history.replaceState(null, '', shareURL);
}

// ============================================
// Loading
// ============================================

/**
 * Handle loading a COG (from file or URL).
 * @param {string|File} source - URL or File object
 */
async function handleLoad(source) {
    try {
        showViewer();

        // Show loading overlay
        loadingProgress = new LoadingProgress(document.body);
        loadingProgress.show();

        // Read options from landing page
        const targetPolygons = parseInt(document.getElementById('polygon-count').value, 10);
        const contoursEnabled = document.getElementById('landing-contour-toggle').checked;
        const contourInterval = parseFloat(document.getElementById('landing-contour-interval').value);
        const zExaggeration = parseFloat(document.getElementById('z-exag-slider').value);
        const normalStrength = parseFloat(document.getElementById('normal-strength-slider').value);

        // Sync contour settings to viewer sidebar
        document.getElementById('contour-toggle').checked = contoursEnabled;
        document.getElementById('contour-interval').value = contourInterval;
        document.getElementById('contour-controls').style.display = contoursEnabled ? '' : 'none';

        // Create viewer
        viewer = new TerrainViewer('#viewer-container', {
            source,
            enableAR: true,
            enableTools: true,
            enableContours: contoursEnabled,
            terrain: {
                polygons: targetPolygons,
                zExaggeration,
                normalStrength
            },
            contours: {
                interval: contourInterval
            },
            onProgress: (stage, percent) => {
                if (loadingProgress) {
                    loadingProgress.setStage(stage);
                    if (percent !== null) {
                        loadingProgress.setProgress(percent);
                    }
                }
            },
            onReady: () => {
                // Hide loading
                if (loadingProgress) {
                    loadingProgress.hide();
                    loadingProgress = null;
                }

                // Update UI
                updateControlsFromData();
                updateDataInfo();
                updateContourUI();

                // Show AR button if supported
                if (viewer.isARSupported()) {
                    document.getElementById('enter-ar-btn').style.display = 'block';
                }
            },
            onError: (err) => {
                console.error('Failed to load COG:', err);
                if (loadingProgress) {
                    loadingProgress.hide();
                    loadingProgress = null;
                }
                showError(`Failed to load: ${err.message}`);
                showLanding();
            },
            onModeChange: (mode) => {
                if (mode === 'desktop') {
                    document.getElementById('exit-ar-btn').style.display = 'none';
                    document.getElementById('enter-ar-btn').style.display = 'block';
                } else if (mode === 'ar') {
                    document.getElementById('enter-ar-btn').style.display = 'none';
                    document.getElementById('exit-ar-btn').style.display = 'block';
                }
            },
            onZExaggerationChange: (exag) => {
                document.getElementById('z-exag-slider').value = exag;
                document.getElementById('z-exag-value').textContent = `${exag.toFixed(1)}x`;
                updateBrowserURL(currentCOGUrl);
            }
        });

    } catch (err) {
        console.error('Failed to load COG:', err);
        if (loadingProgress) {
            loadingProgress.hide();
            loadingProgress = null;
        }
        showError(`Failed to load: ${err.message}`);
        showLanding();
    }
}

// ============================================
// Event Handlers
// ============================================

function initEventHandlers() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const urlInput = document.getElementById('url-input');
    const urlLoadBtn = document.getElementById('url-load-btn');

    // Drop zone - click to browse
    dropZone.addEventListener('click', () => fileInput.click());

    // File input change
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (!file.name.match(/\.tiff?$/i)) {
            showError('Please select a .tif or .tiff file');
            return;
        }

        handleLoad(file);
    });

    // Drag and drop - entire page
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
    });

    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.relatedTarget || e.relatedTarget.nodeName === 'HTML') {
            dropZone.classList.remove('drag-over');
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');

        const file = e.dataTransfer.files[0];
        if (!file) return;

        if (!file.name.match(/\.tiff?$/i)) {
            showError('Please drop a .tif or .tiff file');
            return;
        }

        handleLoad(file);
    });

    // URL load
    urlLoadBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (!url) {
            showError('Please enter a URL');
            return;
        }
        currentCOGUrl = url;
        updateBrowserURL(url);
        handleLoad(url);
    });

    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            urlLoadBtn.click();
        }
    });

    // Reference elevation slider
    const refSlider = document.getElementById('ref-elevation-slider');
    const refValue = document.getElementById('ref-elevation-value');
    let refDebounceTimer = null;

    refSlider.addEventListener('input', () => {
        const val = parseFloat(refSlider.value);
        refValue.textContent = `${val.toFixed(1)} m`;

        clearTimeout(refDebounceTimer);
        refDebounceTimer = setTimeout(async () => {
            if (viewer) {
                await viewer.setReferenceElevation(val);
                updateContourUI();
            }
        }, 150);
    });

    // Z-exaggeration slider
    const zSlider = document.getElementById('z-exag-slider');
    const zValue = document.getElementById('z-exag-value');

    zSlider.addEventListener('input', () => {
        const val = parseFloat(zSlider.value);
        zValue.textContent = `${val.toFixed(1)}x`;

        if (viewer) {
            viewer.setZExaggeration(val);
        }
        updateBrowserURL(currentCOGUrl);
    });

    // Normal map strength slider
    const normalSlider = document.getElementById('normal-strength-slider');
    const normalValue = document.getElementById('normal-strength-value');

    normalSlider.addEventListener('input', () => {
        const val = parseFloat(normalSlider.value);
        normalValue.textContent = `${val.toFixed(1)}`;

        if (viewer) {
            viewer.setNormalStrength(val);
        }
        updateBrowserURL(currentCOGUrl);
    });

    // Contour interval
    const contourInterval = document.getElementById('contour-interval');
    contourInterval.addEventListener('change', async () => {
        const interval = parseFloat(contourInterval.value);
        if (viewer) {
            await viewer.setContourInterval(interval);
            updateContourUI();
        }
        updateBrowserURL(currentCOGUrl);
    });

    // Contour visibility toggle
    const contourToggle = document.getElementById('contour-toggle');
    contourToggle.addEventListener('change', () => {
        if (viewer) {
            viewer.setContourVisibility(contourToggle.checked);
        }
        updateBrowserURL(currentCOGUrl);
    });

    // Enter AR button
    const enterArBtn = document.getElementById('enter-ar-btn');
    const exitArBtn = document.getElementById('exit-ar-btn');

    enterArBtn.addEventListener('click', async () => {
        if (viewer) {
            await viewer.enterARMode();
        }
    });

    // Exit AR button
    exitArBtn.addEventListener('click', async () => {
        if (viewer) {
            await viewer.enterDesktopMode();
        }
    });

    // Load new file button
    document.getElementById('load-new-btn').addEventListener('click', () => {
        showLanding();
    });
}

// ============================================
// Examples
// ============================================

async function loadExamplesList() {
    try {
        const resp = await fetch('examples.json');
        if (!resp.ok) return;
        const examples = await resp.json();
        if (!Array.isArray(examples) || examples.length === 0) return;

        const list = document.getElementById('examples-list');
        for (const ex of examples) {
            const link = document.createElement('a');
            link.className = 'example-btn';
            link.innerHTML = `${ex.name}<span class="example-size">${ex.size}</span>`;
            link.href = buildShareURL(ex.file);
            list.appendChild(link);
        }

        // Update example hrefs when landing page settings change
        const settingEls = ['polygon-count', 'landing-contour-toggle', 'landing-contour-interval'];
        for (const id of settingEls) {
            document.getElementById(id).addEventListener('change', () => {
                const links = list.querySelectorAll('.example-btn');
                let i = 0;
                for (const ex of examples) {
                    if (links[i]) links[i].href = buildShareURL(ex.file);
                    i++;
                }
            });
        }

        document.getElementById('examples-section').style.display = '';
    } catch {
        // Silently ignore — examples section stays hidden
    }
}

// ============================================
// Initialize
// ============================================

const params = applyURLParams();
initEventHandlers();
loadExamplesList();

// Auto-load from ?url= query parameter
const urlParam = params.get('url');
if (urlParam) {
    currentCOGUrl = urlParam;
    document.getElementById('url-input').value = urlParam;
    handleLoad(urlParam);
}

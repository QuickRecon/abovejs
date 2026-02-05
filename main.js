/**
 * main.js — COG Terrain Viewer orchestrator
 *
 * Handles COG loading from file/URL, elevation analysis,
 * 3D scene building, and interactive controls.
 */

import { ARManager } from './terrain/ARManager.js';
import { TerrainMesh } from './terrain/TerrainMesh.js';
import { OverlayLayers } from './terrain/OverlayLayers.js';
import { HandTracking } from './terrain/HandTracking.js';
import { LoadingProgress } from './terrain/LoadingProgress.js';

// ============================================
// State
// ============================================

let arManager = null;
let terrainMesh = null;
let overlayLayers = null;
let handTracking = null;
let loadingProgress = null;

// Cached contour data for scene rebuilds
let lastContourResult = null;

// Maximum contour vertices before auto-hiding for performance
const MAX_CONTOUR_VERTICES = 2_000_000;

// Whether contours were auto-disabled due to exceeding vertex limit
let contoursExceedLimit = false;

// Elevation analysis results
let elevationInfo = {
    minElevation: 0,
    maxElevation: 0,
    referenceElevation: 0,
    depthRange: [0, 31],
    noDataValue: null,
    validFraction: 0,
    width: 0,
    height: 0
};

// ============================================
// COG Loading
// ============================================

/**
 * Load a COG from a URL.
 * @param {string} url
 * @returns {Promise<Object>} { elevation, width, height, geoBounds, noDataValue, fullResElevationPromise }
 */
async function loadCOGFromUrl(url) {
    const tiff = await GeoTIFF.fromUrl(url);
    return await _extractCOGData(tiff);
}

/**
 * Load a COG from a File object.
 * @param {File} file
 * @returns {Promise<Object>}
 */
async function loadCOGFromFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    return await _extractCOGData(tiff);
}

/**
 * Extract elevation data from a GeoTIFF.
 * @param {GeoTIFF} tiff
 * @returns {Promise<Object>}
 */
async function _extractCOGData(tiff) {
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

    // Read at a reduced resolution for the mesh (target ~1000px on longest side)
    const maxMeshDim = 1000;
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

    // Start full-res read in parallel for normal map generation
    const fullResElevationPromise = (async () => {
        // For normal map, use up to 4096px on longest side
        const maxNormalDim = 4096;
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

// ============================================
// Elevation Analysis
// ============================================

/**
 * Analyze elevation data to determine min/max and reference elevation.
 * @param {Float32Array} elevation
 * @param {number|null} noDataValue
 * @returns {Object}
 */
function analyzeElevation(elevation, noDataValue) {
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

    console.log(`Elevation analysis: min=${min.toFixed(2)}, max=${max.toFixed(2)}`);
    console.log(`Valid fraction: ${(validFraction * 100).toFixed(1)}%`);
    console.log(`Reference elevation: ${referenceElevation.toFixed(2)}`);
    console.log(`Depth range: [${depthRange[0]}, ${depthRange[1]}]`);

    return {
        minElevation: min,
        maxElevation: max,
        referenceElevation,
        depthRange,
        validFraction
    };
}

// ============================================
// Scene Building
// ============================================

/**
 * Build the 3D terrain scene from loaded COG data.
 * @param {Object} cogData - From loadCOGFromUrl/loadCOGFromFile
 */
async function buildTerrain(cogData) {
    const { elevation, width, height, geoBounds, noDataValue, fullResElevationPromise } = cogData;

    // Analyze elevation
    const analysis = analyzeElevation(elevation, noDataValue);
    elevationInfo = {
        ...analysis,
        noDataValue,
        width,
        height
    };

    // Update UI controls with analyzed values
    updateControlsFromData();

    // Loading overlay is already visible (shown by handleLoad before COG read).
    // Advance to LOAD_COG complete state.
    if (loadingProgress) {
        loadingProgress.setStage('LOAD_COG');
        loadingProgress.setProgress(100);
    }

    // Create AR manager in desktop 3D mode
    const viewerContainer = document.getElementById('viewer-container');
    arManager = new ARManager();
    await arManager.init({
        containerEl: viewerContainer,
        mapEl: null,
        state: null,
        config: null
    });

    await arManager.enterDesktop3DMode();

    const arScene = arManager.getARScene();
    const modelContainer = arManager.getModelContainer();
    const renderer = arScene.getRenderer();

    // Read landing page options
    const targetPolygons = parseInt(document.getElementById('polygon-count').value, 10);
    const contoursEnabled = document.getElementById('landing-contour-toggle').checked;
    const landingContourInterval = parseFloat(document.getElementById('landing-contour-interval').value);

    // Sync contour settings to viewer sidebar
    document.getElementById('contour-toggle').checked = contoursEnabled;
    document.getElementById('contour-interval').value = landingContourInterval;
    document.getElementById('contour-controls').style.display = contoursEnabled ? '' : 'none';

    // Create terrain mesh
    terrainMesh = new TerrainMesh({ targetPolygons });
    terrainMesh.setElevationConfig(
        elevationInfo.referenceElevation,
        elevationInfo.depthRange,
        noDataValue
    );
    terrainMesh.setRenderer(renderer);

    arManager.setTerrainMesh(terrainMesh);

    // Progress callback
    const onProgress = (stageKey, progress) => {
        if (loadingProgress) {
            loadingProgress.setStage(stageKey);
            if (progress !== null) {
                loadingProgress.setProgress(progress * 100);
            }
        }
    };

    // Build terrain
    await terrainMesh.createFromData({
        elevation,
        width,
        height,
        geoBounds,
        fullResElevationPromise
    }, modelContainer, onProgress);

    // Apply normal scale from slider
    const normalScaleVal = parseFloat(document.getElementById('normal-strength-slider').value);
    terrainMesh.setNormalScale(normalScaleVal);

    // Create overlay layers (contours)
    overlayLayers = new OverlayLayers();
    overlayLayers.init(modelContainer, terrainMesh);
    arManager.setOverlayLayers(overlayLayers);

    // Generate contours (if enabled on landing page)
    if (contoursEnabled) {
        onProgress('CREATE_CONTOURS', null);
        await generateContours(landingContourInterval, onProgress);
    }

    // Set up hand tracking for AR
    handTracking = new HandTracking();
    handTracking.setTerrainMesh(terrainMesh);
    handTracking.setZExaggerationCallback((exag) => {
        overlayLayers.updateForZExaggeration();
        document.getElementById('z-exag-slider').value = exag;
        document.getElementById('z-exag-value').textContent = `${exag.toFixed(1)}x`;
    });
    arManager.setHandTracking(handTracking);

    // When AR session ends (externally or via exit button), rebuild desktop 3D
    arManager.onSessionEnd = async () => {
        console.log('AR session ended — rebuilding desktop 3D scene');
        document.getElementById('exit-ar-btn').style.display = 'none';
        document.getElementById('enter-ar-btn').style.display = 'block';
        await arManager.enterDesktop3DMode();
        rebuildSceneContents();
    };

    // Check AR support and show button if available
    if (arManager.getARSupported()) {
        document.getElementById('enter-ar-btn').style.display = 'block';
    }

    // Hide loading
    if (loadingProgress) {
        loadingProgress.hide();
    }

    // Update data info display
    updateDataInfo();
}

/**
 * Generate contour lines.
 * @param {number} interval
 * @param {Function} [onProgress]
 */
async function generateContours(interval, onProgress) {
    if (!terrainMesh || !overlayLayers) return;

    const result = await terrainMesh.generateContours(
        elevationInfo.referenceElevation,
        elevationInfo.minElevation,
        interval,
        0.0008,
        onProgress ? (p) => onProgress('CREATE_CONTOURS', p) : null,
        0.0001, // simplify tolerance
        MAX_CONTOUR_VERTICES
    );

    lastContourResult = result;

    const contourToggle = document.getElementById('contour-toggle');
    const limitNote = document.getElementById('contour-limit-note');

    if (result?.aborted) {
        contoursExceedLimit = true;
        contourToggle.checked = false;
        contourToggle.disabled = true;
        limitNote.style.display = 'block';
        overlayLayers.setVisibility('contours', false);
    } else if (result && result.vertexCount > 0) {
        contoursExceedLimit = false;
        contourToggle.disabled = false;
        limitNote.style.display = 'none';
        overlayLayers.createContoursFromSegments(result.segments, result.vertexCount);
    }
}

/**
 * Re-attach terrain and overlays to a new model container after scene rebuild.
 * Called when transitioning between desktop3D and AR modes.
 *
 * The ARManager.detachReusableContent() call (before exitMode) removes the
 * terrain mesh and contour group from the old container so they survive
 * disposal. This function adds them to the new container.
 */
function rebuildSceneContents() {
    const modelContainer = arManager.getModelContainer();
    if (!modelContainer) return;

    // Re-add terrain mesh to the new container
    if (terrainMesh?.mesh) {
        if (terrainMesh.mesh.parent) {
            terrainMesh.mesh.parent.remove(terrainMesh.mesh);
        }
        modelContainer.add(terrainMesh.mesh);

        // Point terrainMesh at the new renderer for GPU ops
        const arScene = arManager.getARScene();
        if (arScene) {
            terrainMesh.setRenderer(arScene.getRenderer());
        }
    }

    // Re-attach overlay layers to the new container
    if (overlayLayers) {
        // The contour group was detached (not disposed) — re-parent it
        if (overlayLayers.contourGroup) {
            if (overlayLayers.contourGroup.parent) {
                overlayLayers.contourGroup.parent.remove(overlayLayers.contourGroup);
            }
            modelContainer.add(overlayLayers.contourGroup);
        } else {
            // contourGroup was lost — re-init from scratch
            overlayLayers.init(modelContainer, terrainMesh);

            if (lastContourResult && lastContourResult.vertexCount > 0) {
                overlayLayers.createContoursFromSegments(
                    lastContourResult.segments,
                    lastContourResult.vertexCount
                );
            }
        }

        overlayLayers.parentGroup = modelContainer;
        overlayLayers.terrainMesh = terrainMesh;

        // Respect current toggle state
        const contourToggle = document.getElementById('contour-toggle');
        overlayLayers.setVisibility('contours', contourToggle.checked);
    }
}

// ============================================
// UI Controls
// ============================================

/**
 * Update slider ranges based on analyzed elevation data.
 */
function updateControlsFromData() {
    const refSlider = document.getElementById('ref-elevation-slider');
    const refValue = document.getElementById('ref-elevation-value');

    // Set slider range to data range
    refSlider.min = Math.floor(elevationInfo.minElevation);
    refSlider.max = Math.ceil(elevationInfo.maxElevation);
    refSlider.value = elevationInfo.referenceElevation;
    refValue.textContent = `${elevationInfo.referenceElevation.toFixed(1)} m`;
}

/**
 * Update data info display.
 */
function updateDataInfo() {
    const infoEl = document.getElementById('data-info');
    infoEl.innerHTML = `
        <p>Size: ${elevationInfo.width} x ${elevationInfo.height}</p>
        <p>Min: ${elevationInfo.minElevation.toFixed(2)} m</p>
        <p>Max: ${elevationInfo.maxElevation.toFixed(2)} m</p>
        <p>Range: ${elevationInfo.depthRange[1]} m</p>
        <p>Valid: ${(elevationInfo.validFraction * 100).toFixed(1)}%</p>
        ${elevationInfo.noDataValue !== null ? `<p>NoData: ${elevationInfo.noDataValue}</p>` : ''}
    `;
}

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

    // Clean up
    if (arManager) {
        arManager.dispose();
        arManager = null;
    }
    if (terrainMesh) {
        terrainMesh.dispose();
        terrainMesh = null;
    }
    if (overlayLayers) {
        overlayLayers.dispose();
        overlayLayers = null;
    }
    handTracking = null;
    lastContourResult = null;
    currentCOGUrl = null;
    history.replaceState(null, '', window.location.pathname);

    // Clear the viewer container
    const container = document.getElementById('viewer-container');
    container.innerHTML = '';
}

/**
 * Handle loading a COG (from file or URL).
 * @param {Function} loader - async function that returns COG data
 */
async function handleLoad(loader) {
    try {
        showViewer();

        // Show loading overlay immediately so the user sees feedback
        // before the (potentially slow) COG read begins
        loadingProgress = new LoadingProgress(document.body);
        loadingProgress.show();

        const cogData = await loader();
        await buildTerrain(cogData);
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

        handleLoad(() => loadCOGFromFile(file));
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
        // Only remove class if we left the document
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

        handleLoad(() => loadCOGFromFile(file));
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
        handleLoad(() => loadCOGFromUrl(url));
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

        // Debounce the expensive update
        clearTimeout(refDebounceTimer);
        refDebounceTimer = setTimeout(async () => {
            elevationInfo.referenceElevation = val;
            elevationInfo.depthRange = [0, Math.max(1, Math.round(val - elevationInfo.minElevation))];

            if (terrainMesh) {
                terrainMesh.setElevationConfig(val, elevationInfo.depthRange, elevationInfo.noDataValue);
                await terrainMesh.updateReferenceElevation(val);

                // Regenerate contours (skip if they exceeded the limit)
                if (!contoursExceedLimit) {
                    const interval = parseFloat(document.getElementById('contour-interval').value);
                    await generateContours(interval);
                }
            }
        }, 150);
    });

    // Z-exaggeration slider
    const zSlider = document.getElementById('z-exag-slider');
    const zValue = document.getElementById('z-exag-value');

    zSlider.addEventListener('input', () => {
        const val = parseFloat(zSlider.value);
        zValue.textContent = `${val.toFixed(1)}x`;

        if (terrainMesh) {
            terrainMesh.setZExaggeration(val);
        }
        if (overlayLayers && !contoursExceedLimit) {
            overlayLayers.updateForZExaggeration();
        }
        updateBrowserURL(currentCOGUrl);
    });

    // Normal map strength slider
    const normalSlider = document.getElementById('normal-strength-slider');
    const normalValue = document.getElementById('normal-strength-value');

    normalSlider.addEventListener('input', () => {
        const val = parseFloat(normalSlider.value);
        normalValue.textContent = `${val.toFixed(1)}`;

        if (terrainMesh) {
            terrainMesh.setNormalScale(val);
        }
        updateBrowserURL(currentCOGUrl);
    });

    // Contour interval
    const contourInterval = document.getElementById('contour-interval');
    contourInterval.addEventListener('change', async () => {
        const interval = parseFloat(contourInterval.value);
        await generateContours(interval);
        updateBrowserURL(currentCOGUrl);
    });

    // Contour visibility toggle
    const contourToggle = document.getElementById('contour-toggle');
    contourToggle.addEventListener('change', () => {
        if (contoursExceedLimit) {
            contourToggle.checked = false;
            return;
        }
        if (overlayLayers) {
            overlayLayers.setVisibility('contours', contourToggle.checked);
        }
        updateBrowserURL(currentCOGUrl);
    });

    // Enter AR button
    const enterArBtn = document.getElementById('enter-ar-btn');
    const exitArBtn = document.getElementById('exit-ar-btn');

    enterArBtn.addEventListener('click', async () => {
        if (!arManager) return;

        // enterARMode() acquires the XR session (needs user gesture),
        // then disposes the old scene and creates a new one
        const success = await arManager.enterARMode();
        if (!success) return;

        enterArBtn.style.display = 'none';
        exitArBtn.style.display = 'block';

        // Rebuild terrain/overlays into the new AR scene's model container
        rebuildSceneContents();

        // Init hand tracking on the new scene
        const arScene = arManager.getARScene();
        if (handTracking && arScene) {
            handTracking.init(
                arScene.getRenderer(),
                arScene.getScene(),
                arScene.getCamera(),
                arScene
            );
        }
    });

    // Exit AR button
    exitArBtn.addEventListener('click', async () => {
        if (!arManager) return;
        arManager.detachReusableContent();
        await arManager.exitMode();
        await arManager.enterDesktop3DMode();
        rebuildSceneContents();
        exitArBtn.style.display = 'none';
        enterArBtn.style.display = 'block';
    });

    // Load new file button
    document.getElementById('load-new-btn').addEventListener('click', () => {
        showLanding();
    });
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

    // Read from viewer sidebar if active, otherwise from landing page
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

// Track the loaded COG URL for URL updates
let currentCOGUrl = null;

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
            // Build href with current landing page settings
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

// Apply URL params to landing page controls, then init
const params = applyURLParams();
initEventHandlers();
loadExamplesList();

// Auto-load from ?url= query parameter
const urlParam = params.get('url');
if (urlParam) {
    currentCOGUrl = urlParam;
    document.getElementById('url-input').value = urlParam;
    handleLoad(() => loadCOGFromUrl(urlParam));
}

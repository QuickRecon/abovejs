/**
 * TerrainViewer.js - Main orchestrator for terrain visualization
 *
 * Provides a clean API for loading and viewing COG terrain data
 * with optional AR/XR support.
 */

import { ARManager, ARMode } from './scene/ARManager.js';
import { TerrainMesh } from './core/TerrainMesh.js';
import { OverlayLayers } from './core/OverlayLayers.js';
import { HandTracking } from './ar/HandTracking.js';
import { ToolManager } from './tools/ToolManager.js';
import { loadCOGFromUrl, loadCOGFromFile } from './core/COGLoader.js';
import { analyzeElevation } from './core/ElevationAnalysis.js';

// Maximum contour vertices before auto-hiding for performance
const MAX_CONTOUR_VERTICES = 2_000_000;

/**
 * TerrainViewer manages the complete terrain visualization experience.
 */
export class TerrainViewer {
    /**
     * Create a new TerrainViewer.
     * @param {string|HTMLElement} container - Container element or selector
     * @param {Object} [options] - Configuration options
     * @param {string|File} [options.source] - Initial data source (URL or File)
     * @param {boolean} [options.enableAR=true] - Enable AR mode
     * @param {boolean} [options.enableTools=true] - Enable AR tools (requires enableAR)
     * @param {boolean} [options.enableContours=true] - Enable contour lines
     * @param {Object} [options.terrain] - Terrain configuration
     * @param {number} [options.terrain.polygons=1000000] - Target polygon count
     * @param {number} [options.terrain.zExaggeration=4] - Z exaggeration factor
     * @param {number} [options.terrain.normalStrength=2] - Normal map strength
     * @param {Object} [options.contours] - Contour configuration
     * @param {number} [options.contours.interval=1] - Contour interval in meters
     * @param {Function} [options.onProgress] - Progress callback (stage, percent)
     * @param {Function} [options.onReady] - Ready callback (viewer)
     * @param {Function} [options.onError] - Error callback (error)
     * @param {Function} [options.onModeChange] - Mode change callback ('desktop' | 'ar')
     * @param {Function} [options.onZExaggerationChange] - Z exaggeration change callback (factor)
     */
    constructor(container, options = {}) {
        // Resolve container element
        if (typeof container === 'string') {
            this.containerEl = document.querySelector(container);
        } else {
            this.containerEl = container;
        }

        if (!this.containerEl) {
            throw new Error('TerrainViewer: container element not found');
        }

        // Store options
        this.options = {
            enableAR: options.enableAR ?? true,
            enableTools: options.enableTools ?? true,
            enableContours: options.enableContours ?? true,
            terrain: {
                polygons: options.terrain?.polygons ?? 1_000_000,
                zExaggeration: options.terrain?.zExaggeration ?? 4,
                normalStrength: options.terrain?.normalStrength ?? 2
            },
            contours: {
                interval: options.contours?.interval ?? 1
            }
        };

        // Callbacks
        this.onProgress = options.onProgress ?? (() => {});
        this.onReady = options.onReady ?? (() => {});
        this.onError = options.onError ?? ((err) => console.error(err));
        this.onModeChange = options.onModeChange ?? (() => {});
        this.onZExaggerationChange = options.onZExaggerationChange ?? (() => {});

        // Internal state
        this.arManager = null;
        this.terrainMesh = null;
        this.overlayLayers = null;
        this.handTracking = null;
        this.toolManager = null;

        // Elevation info
        this.elevationInfo = {
            minElevation: 0,
            maxElevation: 0,
            referenceElevation: 0,
            depthRange: [0, 31],
            noDataValue: null,
            validFraction: 0,
            width: 0,
            height: 0
        };

        // Cached contour data for scene rebuilds
        this._lastContourResult = null;
        this._contoursExceedLimit = false;
        this._contoursVisible = this.options.enableContours;

        // Current mode
        this._mode = 'none';

        // Auto-load if source provided
        if (options.source) {
            this.load(options.source);
        }
    }

    /**
     * Load terrain data from a URL or File.
     * @param {string|File} source - COG URL or File object
     * @returns {Promise<void>}
     */
    async load(source) {
        try {
            this.onProgress('LOAD_COG', 0);

            // Load COG data
            let cogData;
            if (typeof source === 'string') {
                cogData = await loadCOGFromUrl(source);
            } else if (source instanceof File) {
                cogData = await loadCOGFromFile(source);
            } else {
                throw new Error('Invalid source: must be URL string or File object');
            }

            this.onProgress('LOAD_COG', 100);

            // Build the terrain
            await this._buildTerrain(cogData);

            this.onReady(this);
        } catch (err) {
            this.onError(err);
            throw err;
        }
    }

    /**
     * Build the terrain from COG data.
     * @param {Object} cogData
     * @private
     */
    async _buildTerrain(cogData) {
        const { elevation, width, height, geoBounds, noDataValue, fullResElevationPromise } = cogData;

        // Analyze elevation
        const analysis = analyzeElevation(elevation, noDataValue);
        this.elevationInfo = {
            ...analysis,
            noDataValue,
            width,
            height
        };

        // Create AR manager
        this.arManager = new ARManager();
        await this.arManager.init({
            containerEl: this.containerEl,
            mapEl: null,
            state: null,
            config: null
        });

        // Start in desktop mode
        await this.arManager.enterDesktop3DMode();
        this._mode = 'desktop';
        this.onModeChange('desktop');

        const arScene = this.arManager.getARScene();
        const modelContainer = this.arManager.getModelContainer();
        const renderer = arScene.getRenderer();

        // Create terrain mesh
        this.terrainMesh = new TerrainMesh({
            targetPolygons: this.options.terrain.polygons
        });
        this.terrainMesh.setElevationConfig(
            this.elevationInfo.referenceElevation,
            this.elevationInfo.depthRange,
            noDataValue
        );
        this.terrainMesh.setRenderer(renderer);
        this.arManager.setTerrainMesh(this.terrainMesh);

        // Build terrain with progress reporting
        await this.terrainMesh.createFromData({
            elevation,
            width,
            height,
            geoBounds,
            fullResElevationPromise
        }, modelContainer, (stage, progress) => {
            this.onProgress(stage, progress !== null ? progress * 100 : null);
        });

        // Apply initial settings
        this.terrainMesh.setZExaggeration(this.options.terrain.zExaggeration);
        this.terrainMesh.setNormalScale(this.options.terrain.normalStrength);

        // Create overlay layers (contours)
        this.overlayLayers = new OverlayLayers();
        this.overlayLayers.init(modelContainer, this.terrainMesh);
        this.arManager.setOverlayLayers(this.overlayLayers);

        // Generate contours if enabled
        if (this.options.enableContours) {
            this.onProgress('CREATE_CONTOURS', null);
            await this._generateContours(this.options.contours.interval);
        }

        // Set up hand tracking for AR
        if (this.options.enableAR) {
            this.handTracking = new HandTracking();
            this.handTracking.setTerrainMesh(this.terrainMesh);
            this.handTracking.setZExaggerationCallback((exag) => {
                this.overlayLayers.updateForZExaggeration();
                this.onZExaggerationChange(exag);
            });
            this.arManager.setHandTracking(this.handTracking);

            // Set up tool manager
            if (this.options.enableTools) {
                this.toolManager = new ToolManager();
                this.arManager.setToolManager(this.toolManager);
            }
        }

        // Handle AR session end
        this.arManager.onSessionEnd = async () => {
            await this.arManager.enterDesktop3DMode();
            this._rebuildSceneContents();
            this._mode = 'desktop';
            this.onModeChange('desktop');
        };
    }

    /**
     * Generate contour lines.
     * @param {number} interval
     * @private
     */
    async _generateContours(interval) {
        if (!this.terrainMesh || !this.overlayLayers) return;

        const result = await this.terrainMesh.generateContours(
            this.elevationInfo.referenceElevation,
            this.elevationInfo.minElevation,
            interval,
            0.0008,
            (p) => this.onProgress('CREATE_CONTOURS', p * 100),
            0.0001,
            MAX_CONTOUR_VERTICES
        );

        this._lastContourResult = result;

        if (result?.aborted) {
            this._contoursExceedLimit = true;
            this._contoursVisible = false;
            this.overlayLayers.setVisibility('contours', false);
        } else if (result && result.vertexCount > 0) {
            this._contoursExceedLimit = false;
            this.overlayLayers.createContoursFromSegments(result.segments, result.vertexCount);
            this.overlayLayers.setVisibility('contours', this._contoursVisible);
        }
    }

    /**
     * Re-attach terrain and overlays after mode switch.
     * @private
     */
    _rebuildSceneContents() {
        const modelContainer = this.arManager.getModelContainer();
        if (!modelContainer) return;

        // Re-add terrain mesh
        if (this.terrainMesh?.mesh) {
            if (this.terrainMesh.mesh.parent) {
                this.terrainMesh.mesh.parent.remove(this.terrainMesh.mesh);
            }
            modelContainer.add(this.terrainMesh.mesh);

            const arScene = this.arManager.getARScene();
            if (arScene) {
                this.terrainMesh.setRenderer(arScene.getRenderer());
            }
        }

        // Re-attach overlay layers
        if (this.overlayLayers) {
            if (this.overlayLayers.contourGroup) {
                if (this.overlayLayers.contourGroup.parent) {
                    this.overlayLayers.contourGroup.parent.remove(this.overlayLayers.contourGroup);
                }
                modelContainer.add(this.overlayLayers.contourGroup);
            } else {
                this.overlayLayers.init(modelContainer, this.terrainMesh);
                if (this._lastContourResult && this._lastContourResult.vertexCount > 0) {
                    this.overlayLayers.createContoursFromSegments(
                        this._lastContourResult.segments,
                        this._lastContourResult.vertexCount
                    );
                }
            }
            this.overlayLayers.parentGroup = modelContainer;
            this.overlayLayers.terrainMesh = this.terrainMesh;
            this.overlayLayers.setVisibility('contours', this._contoursVisible);
        }

        // Re-attach tools
        if (this.toolManager) {
            this.toolManager.reattach(modelContainer);
        }
    }

    // ============================================
    // Public API - Terrain Parameters
    // ============================================

    /**
     * Set the Z exaggeration factor.
     * @param {number} factor - Exaggeration factor (1-10)
     */
    setZExaggeration(factor) {
        if (this.terrainMesh) {
            this.terrainMesh.setZExaggeration(factor);
        }
        if (this.overlayLayers && !this._contoursExceedLimit) {
            this.overlayLayers.updateForZExaggeration();
        }
    }

    /**
     * Get the current Z exaggeration factor.
     * @returns {number}
     */
    getZExaggeration() {
        return this.terrainMesh?.getZExaggeration() ?? this.options.terrain.zExaggeration;
    }

    /**
     * Set the normal map strength.
     * @param {number} strength - Normal strength (0-10)
     */
    setNormalStrength(strength) {
        if (this.terrainMesh) {
            this.terrainMesh.setNormalScale(strength);
        }
    }

    /**
     * Set the reference elevation and update the terrain.
     * @param {number} elevation - Reference elevation in meters
     */
    async setReferenceElevation(elevation) {
        this.elevationInfo.referenceElevation = elevation;
        this.elevationInfo.depthRange = [0, Math.max(1, Math.round(elevation - this.elevationInfo.minElevation))];

        if (this.terrainMesh) {
            this.terrainMesh.setElevationConfig(
                elevation,
                this.elevationInfo.depthRange,
                this.elevationInfo.noDataValue
            );
            await this.terrainMesh.updateReferenceElevation(elevation);

            // Regenerate contours
            if (!this._contoursExceedLimit && this._contoursVisible) {
                await this._generateContours(this.options.contours.interval);
            }
        }
    }

    /**
     * Set the contour interval and regenerate contours.
     * @param {number} interval - Contour interval in meters
     */
    async setContourInterval(interval) {
        this.options.contours.interval = interval;
        if (!this._contoursExceedLimit) {
            await this._generateContours(interval);
        }
    }

    /**
     * Set contour visibility.
     * @param {boolean} visible
     */
    setContourVisibility(visible) {
        if (this._contoursExceedLimit) return;
        this._contoursVisible = visible;
        if (this.overlayLayers) {
            this.overlayLayers.setVisibility('contours', visible);
        }
    }

    /**
     * Check if contours are visible.
     * @returns {boolean}
     */
    isContourVisible() {
        return this._contoursVisible && !this._contoursExceedLimit;
    }

    /**
     * Check if contours exceeded the vertex limit.
     * @returns {boolean}
     */
    contoursExceededLimit() {
        return this._contoursExceedLimit;
    }

    /**
     * Get the elevation range.
     * @returns {{ min: number, max: number, reference: number }}
     */
    getElevationRange() {
        return {
            min: this.elevationInfo.minElevation,
            max: this.elevationInfo.maxElevation,
            reference: this.elevationInfo.referenceElevation
        };
    }

    /**
     * Get full elevation info.
     * @returns {Object}
     */
    getElevationInfo() {
        return { ...this.elevationInfo };
    }

    // ============================================
    // Public API - Mode Control
    // ============================================

    /**
     * Check if AR is supported.
     * @returns {boolean}
     */
    isARSupported() {
        return this.arManager?.getARSupported() ?? false;
    }

    /**
     * Get the current mode.
     * @returns {'none'|'desktop'|'ar'}
     */
    getMode() {
        return this._mode;
    }

    /**
     * Enter desktop 3D mode.
     */
    async enterDesktopMode() {
        if (!this.arManager || this._mode === 'desktop') return;

        if (this._mode === 'ar') {
            this.arManager.detachReusableContent();
            await this.arManager.exitMode();
        }

        await this.arManager.enterDesktop3DMode();
        this._rebuildSceneContents();
        this._mode = 'desktop';
        this.onModeChange('desktop');
    }

    /**
     * Enter AR mode.
     * @returns {Promise<boolean>} Success
     */
    async enterARMode() {
        if (!this.arManager || !this.isARSupported()) return false;
        if (this._mode === 'ar') return true;

        const success = await this.arManager.enterARMode();
        if (!success) return false;

        this._rebuildSceneContents();

        // Init hand tracking
        const arScene = this.arManager.getARScene();
        if (this.handTracking && arScene) {
            this.handTracking.init(
                arScene.getRenderer(),
                arScene.getScene(),
                arScene.getCamera(),
                arScene
            );

            if (this.toolManager) {
                this.toolManager.init(
                    arScene.getScene(),
                    arScene.getCamera(),
                    this.arManager.getModelContainer(),
                    this.terrainMesh,
                    this.handTracking.hand1,
                    this.handTracking.hand2,
                    this.handTracking.hands
                );
                this.toolManager.onInteractionStateChange = (active) => {
                    this.handTracking.setToolInteractionActive(active);
                };
            }
        }

        this._mode = 'ar';
        this.onModeChange('ar');
        return true;
    }

    // ============================================
    // Public API - Cleanup
    // ============================================

    /**
     * Dispose of all resources.
     */
    dispose() {
        if (this.arManager) {
            this.arManager.dispose();
            this.arManager = null;
        }
        if (this.terrainMesh) {
            this.terrainMesh.dispose();
            this.terrainMesh = null;
        }
        if (this.overlayLayers) {
            this.overlayLayers.dispose();
            this.overlayLayers = null;
        }
        if (this.toolManager) {
            this.toolManager.dispose();
            this.toolManager = null;
        }
        this.handTracking = null;
        this._lastContourResult = null;
        this._mode = 'none';
    }
}

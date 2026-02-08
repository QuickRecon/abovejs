/**
 * ARManager.js - WebXR session management for AR/VR modes
 *
 * Handles WebXR session lifecycle, AR support detection,
 * desktop 3D preview mode, and mode switching.
 */

import * as THREE from 'three';
import { ARScene } from './ARScene.js';

/**
 * Mode enumeration for the AR system.
 */
export const ARMode = {
    NONE: 'none',
    DESKTOP_3D: 'desktop3d',
    AR: 'ar'
};

/**
 * ARManager coordinates the AR/3D experience.
 */
export class ARManager {
    arScene = null;
    currentMode = ARMode.NONE;
    xrSession = null;
    isARSupported = false;
    useVRFallback = false;

    // References to other AR components
    terrainMesh = null;
    handTracking = null;
    overlayLayers = null;
    toolManager = null;

    // Callbacks
    onModeChange = null;
    onSessionStart = null;
    onSessionEnd = null;

    // DOM elements
    containerEl = null;
    mapEl = null;

    // State from main app
    appState = null;
    appConfig = null;

    /**
     * Initialize the AR manager.
     * @param {Object} options
     * @param {HTMLElement} options.containerEl - Container for 3D rendering
     * @param {HTMLElement} options.mapEl - The 2D map container (to hide in 3D mode)
     * @param {Object} options.state - Application state
     * @param {Object} options.config - Application config
     */
    async init(options) {
        const { containerEl, mapEl, state, config } = options;

        this.containerEl = containerEl;
        this.mapEl = mapEl;
        this.appState = state;
        this.appConfig = config;

        // Create the AR scene
        this.arScene = new ARScene();

        // Check for AR support
        await this._checkARSupport();

        return this;
    }

    /**
     * Check if WebXR AR is supported on this device.
     */
    async _checkARSupport() {
        if (!navigator.xr) {
            console.log('WebXR not available');
            this.isARSupported = false;
            return;
        }

        try {
            // Check for immersive-ar support
            this.isARSupported = await navigator.xr.isSessionSupported('immersive-ar');
            console.log('immersive-ar support:', this.isARSupported);

            // Also check for immersive-vr as Quest supports both
            if (!this.isARSupported) {
                const vrSupported = await navigator.xr.isSessionSupported('immersive-vr');
                console.log('immersive-vr support:', vrSupported);
                // On Quest, we can use VR mode with passthrough
                if (vrSupported && this._isQuestDevice()) {
                    console.log('Quest detected with VR support - enabling AR mode');
                    this.isARSupported = true;
                    this.useVRFallback = true;
                }
            }
        } catch (e) {
            console.warn('Error checking AR support:', e);
            this.isARSupported = false;
        }
    }

    /**
     * Check if this is a Quest device.
     */
    _isQuestDevice() {
        const ua = navigator.userAgent;
        return ua.includes('Quest') || ua.includes('Oculus');
    }

    /**
     * Check if AR mode is available.
     * @returns {boolean}
     */
    getARSupported() {
        return this.isARSupported;
    }

    /**
     * Get the current mode.
     * @returns {string} One of ARMode values
     */
    getCurrentMode() {
        return this.currentMode;
    }

    /**
     * Enter desktop 3D preview mode.
     */
    async enterDesktop3DMode() {
        if (this.currentMode !== ARMode.NONE) {
            this.detachReusableContent();
            await this.exitMode();
        }

        console.log('Entering desktop 3D mode');

        // Show 3D container, hide map
        this.containerEl.style.display = 'block';
        if (this.mapEl) {
            this.mapEl.style.display = 'none';
        }

        // Initialize the scene
        this.arScene.init(this.containerEl, { alpha: false });
        this.arScene.setARMode(false);

        // Set up render callback
        this.arScene.setRenderCallback(this._onRender.bind(this));

        // Start rendering
        this.arScene.start();

        // Position camera for desktop view
        const camera = this.arScene.getCamera();
        camera.position.set(0, 0.4, 0.6);
        camera.lookAt(0, 0, 0);

        this.currentMode = ARMode.DESKTOP_3D;

        if (this.onModeChange) {
            this.onModeChange(this.currentMode);
        }

        return true;
    }

    /**
     * Enter AR mode (Quest 3 passthrough).
     */
    async enterARMode() {
        if (!this.isARSupported) {
            console.warn('AR not supported on this device');
            return false;
        }

        console.log('Entering AR mode');

        // Request XR session FIRST — requestSession must be called synchronously
        // within a user gesture. Any `await` before this (e.g. exitMode) would
        // break the user activation context and cause the request to hang.
        const sessionType = this.useVRFallback ? 'immersive-vr' : 'immersive-ar';
        const sessionInit = {
            requiredFeatures: ['local-floor'],
            optionalFeatures: ['hand-tracking', 'bounded-floor']
        };

        let session;
        try {
            console.log(`Requesting ${sessionType} session...`);
            session = await navigator.xr.requestSession(sessionType, sessionInit);
        } catch (e) {
            console.error('Failed to request XR session:', e);
            return false;
        }

        // Session acquired — now safe to clean up previous mode.
        // Detach reusable content first so arScene.dispose() doesn't destroy it.
        if (this.currentMode !== ARMode.NONE) {
            this.detachReusableContent();
            await this.exitMode();
        }

        // Show 3D container, hide map
        this.containerEl.style.display = 'block';
        if (this.mapEl) {
            this.mapEl.style.display = 'none';
        }

        // Initialize the scene
        this.arScene.init(this.containerEl, { alpha: true });
        this.arScene.setARMode(true);

        // Set up render callback
        this.arScene.setRenderCallback(this._onRender.bind(this));

        try {
            this.xrSession = session;

            // Set up session
            await this.arScene.getRenderer().xr.setSession(session);

            // Enable fixed foveated rendering for performance
            this.arScene.getRenderer().xr.setFoveation(1);

            // Handle session end
            session.addEventListener('end', () => {
                this._onSessionEnd();
            });

            // Handle visibility changes (e.g., Quest menu opens)
            session.addEventListener('visibilitychange', () => {
                this._onVisibilityChange(session);
            });

            // Start rendering
            this.arScene.start();

            // Spawn model in front of user after a short delay
            // (wait for tracking to initialize)
            setTimeout(() => {
                this.arScene.spawnModelInFront(0.7, -0.2);
            }, 500);

            this.currentMode = ARMode.AR;

            if (this.onModeChange) {
                this.onModeChange(this.currentMode);
            }

            if (this.onSessionStart) {
                this.onSessionStart(session);
            }

            return true;

        } catch (e) {
            console.error('Failed to enter AR mode:', e);
            // End session since we acquired it but failed to set up
            try { await session.end(); } catch { /* ignore */ }
            this.containerEl.style.display = 'none';
            if (this.mapEl) {
                this.mapEl.style.display = 'block';
            }
            return false;
        }
    }

    /**
     * Handle XR session end.
     */
    async _onSessionEnd() {
        console.log('AR session ended');
        this.xrSession = null;
        this.detachReusableContent();
        await this.exitMode();

        if (this.onSessionEnd) {
            this.onSessionEnd();
        }
    }

    /**
     * Handle XR session visibility changes.
     * Called when Quest menu opens (visible-blurred) or closes (visible).
     */
    _onVisibilityChange(session) {
        const visibility = session.visibilityState;
        console.log('XR visibility changed:', visibility);

        const shouldPause = visibility === 'visible-blurred' || visibility === 'hidden';

        // Pause the render loop to keep model stable and reduce GPU load
        // HandTracking checks arScene.isSessionPaused automatically
        if (this.arScene) {
            this.arScene.setSessionPaused(shouldPause);
        }

        // Reset gesture state when pausing to prevent phantom inputs
        if (shouldPause) {
            if (this.handTracking) {
                this.handTracking.onSessionPaused();
            }
            if (this.toolManager) {
                this.toolManager.reset();
            }
        }
    }

    /**
     * Detach reusable content (terrain mesh, overlay groups) from the model
     * container so they survive arScene.dispose(). Must be called before
     * exitMode() when you intend to re-attach them to a new scene.
     */
    detachReusableContent() {
        const container = this.arScene?.getModelContainer();
        if (!container) return;

        // Detach terrain mesh
        if (this.terrainMesh?.mesh && this.terrainMesh.mesh.parent === container) {
            container.remove(this.terrainMesh.mesh);
        }

        // Detach overlay contour groups
        if (this.overlayLayers?.contourGroup && this.overlayLayers.contourGroup.parent === container) {
            container.remove(this.overlayLayers.contourGroup);
        }

        // Detach tool groups so they survive scene disposal
        if (this.toolManager) {
            for (const entry of this.toolManager.tools) {
                if (entry.tool.group.parent === container) {
                    container.remove(entry.tool.group);
                }
            }
        }
    }

    /**
     * Exit current mode and return to 2D map.
     */
    async exitMode() {
        console.log('Exiting mode:', this.currentMode);

        // End XR session if active
        if (this.xrSession) {
            try {
                await this.xrSession.end();
            } catch {
                // Session may already be ended - ignore
            }
            this.xrSession = null;
        }

        // Stop and dispose scene
        if (this.arScene) {
            this.arScene.stop();
            this.arScene.dispose();
            this.arScene = new ARScene(); // Create fresh instance for next use
        }

        // Hide 3D container, show map
        this.containerEl.style.display = 'none';
        if (this.mapEl) {
            this.mapEl.style.display = 'block';
        }

        this.currentMode = ARMode.NONE;

        if (this.onModeChange) {
            this.onModeChange(this.currentMode);
        }
    }

    /**
     * Render callback called each frame.
     */
    _onRender(time, frame) {
        if (this.currentMode === ARMode.AR && frame) {
            // Update tool manager BEFORE hand tracking so tool interactions
            // can suppress map gestures for the current frame.
            // Wrapped in try/catch so tool errors never block hand tracking.
            if (this.toolManager) {
                try {
                    this.toolManager.update(frame);
                } catch (e) {
                    console.warn('ToolManager update error:', e);
                }
            }

            if (this.handTracking) {
                this.handTracking.update(frame, this.arScene.getModelContainer());
            }
        }
    }

    /**
     * Set the terrain mesh component.
     * @param {TerrainMesh} terrainMesh
     */
    setTerrainMesh(terrainMesh) {
        this.terrainMesh = terrainMesh;
    }

    /**
     * Set the hand tracking component.
     * @param {HandTracking} handTracking
     */
    setHandTracking(handTracking) {
        this.handTracking = handTracking;
    }

    /**
     * Set the tool manager component.
     * @param {ToolManager} toolManager
     */
    setToolManager(toolManager) {
        this.toolManager = toolManager;
    }

    /**
     * Set the overlay layers component.
     * @param {OverlayLayers} overlayLayers
     */
    setOverlayLayers(overlayLayers) {
        this.overlayLayers = overlayLayers;
    }

    /**
     * Get the AR scene.
     * @returns {ARScene}
     */
    getARScene() {
        return this.arScene;
    }

    /**
     * Get the model container for adding terrain/overlays.
     * @returns {THREE.Group}
     */
    getModelContainer() {
        return this.arScene ? this.arScene.getModelContainer() : null;
    }

    /**
     * Clean up all resources.
     */
    dispose() {
        this.exitMode();
        this.terrainMesh = null;
        this.handTracking = null;
        this.overlayLayers = null;
        this.toolManager = null;
        this.appState = null;
        this.appConfig = null;
    }
}

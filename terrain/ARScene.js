/**
 * ARScene.js - Three.js scene infrastructure for AR/3D visualization
 *
 * Creates and manages the Three.js scene, camera, renderer, and lighting.
 * Provides a model container group for terrain and overlay transforms.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeHierarchy } from './utils.js';

/**
 * ARScene manages the Three.js rendering environment.
 */
export class ARScene {
    scene = null;
    camera = null;
    renderer = null;
    controls = null;
    modelContainer = null;
    containerEl = null;
    animationId = null;
    isRunning = false;
    isARMode = false;

    // Loading indicator
    loadingIndicator = null;
    isLoading = false;

    // Callbacks
    onRender = null;

    // Session pause state (for when XR session is blurred/hidden)
    isSessionPaused = false;

    /**
     * Initialize the Three.js scene.
     * @param {HTMLElement} containerEl - DOM element to render into
     * @param {Object} options - Configuration options
     * @param {boolean} options.antialias - Enable antialiasing (default true)
     * @param {boolean} options.alpha - Transparent background for AR (default true)
     */
    init(containerEl, options = {}) {
        this.containerEl = containerEl;
        const { antialias = true, alpha = true } = options;

        // Create scene
        this.scene = new THREE.Scene();

        // Create camera
        const aspect = containerEl.clientWidth / containerEl.clientHeight;
        // Far plane of 100m is sufficient for tabletop AR viewing
        this.camera = new THREE.PerspectiveCamera(70, aspect, 0.01, 100);
        this.camera.position.set(0, 0.5, 1);

        // Create renderer
        this.renderer = new THREE.WebGLRenderer({
            antialias,
            alpha,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(containerEl.clientWidth, containerEl.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.xr.enabled = true;
        this.renderer.localClippingEnabled = true; // Enable material clipping planes
        containerEl.appendChild(this.renderer.domElement);

        // Create model container group (all terrain/overlays go here for unified transforms)
        this.modelContainer = new THREE.Group();
        this.modelContainer.name = 'modelContainer';
        this.scene.add(this.modelContainer);

        // Add lighting
        this._setupLighting();

        // Add orbit controls for desktop preview
        this._setupControls();

        // Create loading indicator
        this._createLoadingIndicator();

        // Handle resize
        this._boundResize = this._onResize.bind(this);
        window.addEventListener('resize', this._boundResize);

        return this;
    }

    /**
     * Set up scene lighting.
     */
    _setupLighting() {
        // Ambient light for base illumination (increased to compensate for removed hemisphere)
        const ambient = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(ambient);

        // Directional light for terrain shading
        const directional = new THREE.DirectionalLight(0xffffff, 0.8);
        directional.position.set(5, 10, 5);
        directional.castShadow = false;
        this.scene.add(directional);
    }

    /**
     * Set up orbit controls for desktop preview mode.
     */
    _setupControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;
        this.controls.screenSpacePanning = true;
        this.controls.minDistance = 0.1;
        this.controls.maxDistance = 5;
        this.controls.target.set(0, 0, 0);
        this.controls.enabled = true;
    }

    /**
     * Create a 3D loading indicator (spinning ring).
     * Works in both desktop and VR modes.
     */
    _createLoadingIndicator() {
        // Create a group to hold the loading indicator
        this.loadingIndicator = new THREE.Group();
        this.loadingIndicator.name = 'loadingIndicator';

        // Create spinning torus (ring)
        const torusGeometry = new THREE.TorusGeometry(0.05, 0.008, 8, 32, Math.PI * 1.5);
        const torusMaterial = new THREE.MeshBasicMaterial({
            color: 0x4fc3f7,
            transparent: true,
            opacity: 0.9
        });
        const torus = new THREE.Mesh(torusGeometry, torusMaterial);
        torus.name = 'spinnerRing';
        this.spinnerRing = torus;  // Cache reference to avoid per-frame lookup
        this.loadingIndicator.add(torus);

        // Create center dot
        const dotGeometry = new THREE.SphereGeometry(0.01, 16, 16);
        const dotMaterial = new THREE.MeshBasicMaterial({ color: 0x4fc3f7 });
        const dot = new THREE.Mesh(dotGeometry, dotMaterial);
        this.loadingIndicator.add(dot);

        // Create canvas for text (will be updated dynamically)
        this._loadingTextCanvas = document.createElement('canvas');
        this._loadingTextCanvas.width = 512;
        this._loadingTextCanvas.height = 128;

        const textTexture = new THREE.CanvasTexture(this._loadingTextCanvas);
        textTexture.needsUpdate = true;
        this._loadingTextTexture = textTexture;

        const textMaterial = new THREE.SpriteMaterial({
            map: textTexture,
            transparent: true
        });
        const textSprite = new THREE.Sprite(textMaterial);
        textSprite.scale.set(0.2, 0.05, 1);
        textSprite.position.y = -0.08;
        this._loadingTextSprite = textSprite;
        this.loadingIndicator.add(textSprite);

        // Create progress bar background
        const barBgGeometry = new THREE.PlaneGeometry(0.12, 0.008);
        const barBgMaterial = new THREE.MeshBasicMaterial({
            color: 0x1a3a4a,
            transparent: true,
            opacity: 0.8
        });
        const barBg = new THREE.Mesh(barBgGeometry, barBgMaterial);
        barBg.position.y = -0.12;
        this.loadingIndicator.add(barBg);

        // Create progress bar fill
        const barFillGeometry = new THREE.PlaneGeometry(0.12, 0.006);
        const barFillMaterial = new THREE.MeshBasicMaterial({
            color: 0x4fc3f7,
            transparent: true,
            opacity: 0.9
        });
        const barFill = new THREE.Mesh(barFillGeometry, barFillMaterial);
        barFill.position.y = -0.12;
        barFill.position.z = 0.001; // Slightly in front of background
        barFill.scale.x = 0; // Start at 0% width
        this._loadingBarFill = barFill;
        this.loadingIndicator.add(barFill);

        // Initialize text
        this._updateLoadingText('Loading...', 0);

        // Initially hidden
        this.loadingIndicator.visible = false;
        this.scene.add(this.loadingIndicator);
    }

    /**
     * Update the loading indicator text and progress.
     * @param {string} text - Status text to display
     * @param {number} progress - Progress percentage (0-100)
     */
    _updateLoadingText(text, progress) {
        if (!this._loadingTextCanvas) return;

        const canvas = this._loadingTextCanvas;
        const ctx = canvas.getContext('2d');

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw stage text
        ctx.fillStyle = '#4fc3f7';
        ctx.font = 'bold 36px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, canvas.height / 2 - 10);

        // Draw progress percentage
        ctx.font = '28px Arial';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.fillText(`${Math.round(progress)}%`, canvas.width / 2, canvas.height / 2 + 30);

        // Update texture
        if (this._loadingTextTexture) {
            this._loadingTextTexture.needsUpdate = true;
        }

        // Update progress bar
        if (this._loadingBarFill) {
            this._loadingBarFill.scale.x = Math.max(0.001, progress / 100);
            // Shift position to keep bar left-aligned
            this._loadingBarFill.position.x = -0.06 * (1 - progress / 100);
        }
    }

    /**
     * Set the loading stage and progress (for 3D indicator).
     * @param {string} stageName - Human-readable stage name
     * @param {number} progress - Progress percentage (0-100)
     */
    setLoadingProgress(stageName, progress) {
        this._updateLoadingText(stageName, progress);
    }

    /**
     * Show the loading indicator.
     * Positions it in front of the camera.
     */
    showLoading() {
        if (!this.loadingIndicator) return;

        this.isLoading = true;
        this.loadingIndicator.visible = true;

        // Position in front of camera
        this._updateLoadingPosition();
    }

    /**
     * Hide the loading indicator.
     */
    hideLoading() {
        if (!this.loadingIndicator) return;

        this.isLoading = false;
        this.loadingIndicator.visible = false;
    }

    /**
     * Update loading indicator position to stay in front of camera.
     */
    _updateLoadingPosition() {
        if (!this.loadingIndicator?.visible || !this.camera) return;

        // Get camera position and direction
        const cameraPos = new THREE.Vector3();
        const cameraDir = new THREE.Vector3();
        this.camera.getWorldPosition(cameraPos);
        this.camera.getWorldDirection(cameraDir);

        // Position 0.5m in front of camera
        const targetPos = cameraPos.clone().add(cameraDir.multiplyScalar(0.5));
        this.loadingIndicator.position.copy(targetPos);

        // Face the camera
        this.loadingIndicator.lookAt(cameraPos);
    }

    /**
     * Animate the loading indicator.
     */
    _animateLoading() {
        if (!this.loadingIndicator?.visible) return;

        // Spin the ring (using cached reference)
        if (this.spinnerRing) {
            this.spinnerRing.rotation.z -= 0.05;
        }

        // Update position to follow camera (especially in VR)
        if (this.isARMode) {
            this._updateLoadingPosition();
        }
    }

    /**
     * Handle window resize.
     */
    _onResize() {
        if (!this.containerEl || !this.camera || !this.renderer) return;

        const width = this.containerEl.clientWidth;
        const height = this.containerEl.clientHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    /**
     * Get the model container group for adding terrain and overlays.
     * @returns {THREE.Group}
     */
    getModelContainer() {
        return this.modelContainer;
    }

    /**
     * Get the Three.js renderer (needed for WebXR).
     * @returns {THREE.WebGLRenderer}
     */
    getRenderer() {
        return this.renderer;
    }

    /**
     * Get the camera.
     * @returns {THREE.PerspectiveCamera}
     */
    getCamera() {
        return this.camera;
    }

    /**
     * Get the scene.
     * @returns {THREE.Scene}
     */
    getScene() {
        return this.scene;
    }

    /**
     * Enable/disable orbit controls (disabled in AR mode).
     * @param {boolean} enabled
     */
    setControlsEnabled(enabled) {
        if (this.controls) {
            this.controls.enabled = enabled;
        }
    }

    /**
     * Set AR mode (adjusts rendering for passthrough).
     * @param {boolean} isAR
     */
    setARMode(isAR) {
        this.isARMode = isAR;

        if (isAR) {
            // Transparent background for passthrough
            this.scene.background = null;
            this.setControlsEnabled(false);
        } else {
            // Optional: set a background for desktop preview
            // this.scene.background = new THREE.Color(0xf0f0f0);
            this.scene.background = null;
            this.setControlsEnabled(true);
        }
    }

    /**
     * Position the model in front of the camera (for AR spawn).
     * @param {number} distance - Distance from camera in meters
     * @param {number} heightOffset - Vertical offset from camera (default -0.3 for chest height)
     */
    spawnModelInFront(distance = 0.7, heightOffset = -0.3) {
        if (!this.camera || !this.modelContainer) return;

        // Get camera world position and direction
        const cameraPos = new THREE.Vector3();
        const cameraDir = new THREE.Vector3();
        this.camera.getWorldPosition(cameraPos);
        this.camera.getWorldDirection(cameraDir);

        // Position model in front of camera
        const targetPos = cameraPos.clone()
            .add(cameraDir.multiplyScalar(distance));
        targetPos.y += heightOffset;

        this.modelContainer.position.copy(targetPos);

        // Make model face the camera (rotate around Y axis)
        const lookAtPos = cameraPos.clone();
        lookAtPos.y = targetPos.y;
        this.modelContainer.lookAt(lookAtPos);
    }

    /**
     * Start the render loop.
     */
    start() {
        if (this.isRunning) return;
        this.isRunning = true;

        this.renderer.setAnimationLoop(this._render.bind(this));
    }

    /**
     * Stop the render loop.
     */
    stop() {
        this.isRunning = false;
        if (this.renderer) {
            this.renderer.setAnimationLoop(null);
        }
    }

    /**
     * Main render function called each frame.
     */
    _render(time, frame) {
        // When session is paused (Quest menu open, etc.):
        // - Skip app logic (hand tracking, controls, animations) to reduce load
        // - BUT continue rendering to maintain WebXR pose tracking
        if (!this.isSessionPaused) {
            // Update orbit controls (desktop mode)
            if (this.controls?.enabled) {
                this.controls.update();
            }

            // Animate loading indicator
            this._animateLoading();

            // Call external render callback (for hand tracking updates, etc.)
            if (this.onRender) {
                this.onRender(time, frame);
            }
        }

        // ALWAYS render the scene - required for WebXR pose tracking
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Set session paused state.
     * When paused, the render loop skips app logic (hand tracking, controls, animations)
     * but continues rendering to maintain WebXR pose tracking.
     * @param {boolean} paused
     */
    setSessionPaused(paused) {
        this.isSessionPaused = paused;
    }

    /**
     * Set the render callback for external updates.
     * @param {Function} callback - (time, frame) => void
     */
    setRenderCallback(callback) {
        this.onRender = callback;
    }

    /**
     * Reset model container transforms.
     */
    resetModelTransform() {
        if (!this.modelContainer) return;

        this.modelContainer.position.set(0, 0, 0);
        this.modelContainer.rotation.set(0, 0, 0);
        this.modelContainer.scale.set(1, 1, 1);
    }

    /**
     * Clean up and dispose of all resources.
     */
    dispose() {
        this.stop();

        window.removeEventListener('resize', this._boundResize);

        if (this.controls) {
            this.controls.dispose();
            this.controls = null;
        }

        // Dispose of loading indicator
        if (this.loadingIndicator) {
            disposeHierarchy(this.loadingIndicator);
            this.scene.remove(this.loadingIndicator);
            this.loadingIndicator = null;
        }
        this._loadingTextCanvas = null;
        this._loadingTextTexture = null;
        this._loadingTextSprite = null;
        this._loadingBarFill = null;
        this.spinnerRing = null;

        // Dispose of all objects in the model container
        if (this.modelContainer) {
            disposeHierarchy(this.modelContainer);
            this.scene.remove(this.modelContainer);
            this.modelContainer = null;
        }

        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement?.parentNode) {
                this.renderer.domElement.remove();
            }
            this.renderer = null;
        }

        this.scene = null;
        this.camera = null;
        this.containerEl = null;
    }
}

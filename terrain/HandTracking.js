/**
 * HandTracking.js - WebXR hand tracking and gesture recognition
 *
 * Implements pinch gestures for terrain manipulation:
 * - Single-hand pinch: drag/move
 * - Two-hand horizontal pinch: scale and rotate
 * - Two-hand vertical pinch: Z-exaggeration
 */

import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

/**
 * Gesture types.
 */
export const GestureType = {
    NONE: 'none',
    DRAG: 'drag',
    SCALE_ROTATE: 'scale_rotate',
    Z_EXAGGERATION: 'z_exaggeration'
};

/**
 * Configuration defaults.
 */
const DEFAULT_CONFIG = {
    // Pinch detection threshold (meters between thumb and index)
    pinchThreshold: 0.025,

    // Pinch intent delay (ms) to prevent accidental triggers
    pinchIntentDelay: 100,

    // Inertia settings
    inertiaEnabled: true,
    positionDamping: 100,
    rotationDamping: 8,
    scaleDamping: 8,

    // Distance-based gain for dragging
    distanceGainMin: 0.5,
    distanceGainMax: 2,
    distanceReference: 0.7, // Reference distance in meters

    // Z-exaggeration sensitivity
    zExaggerationSensitivity: 20, // Units per meter of vertical hand movement

    // Vertical vs horizontal threshold for gesture detection
    verticalThreshold: 0.7 // cos(45deg) ≈ 0.707
};

/**
 * HandTracking manages WebXR hand input and gesture recognition.
 */
export class HandTracking {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Three.js references
        this.renderer = null;
        this.scene = null;
        this.camera = null;

        // Hand objects
        this.hand1 = null;
        this.hand2 = null;
        this.handModel1 = null;
        this.handModel2 = null;

        // Hand state
        this.hands = [
            { isPinching: false, pinchStartTime: 0, position: new THREE.Vector3(), prevPosition: new THREE.Vector3() },
            { isPinching: false, pinchStartTime: 0, position: new THREE.Vector3(), prevPosition: new THREE.Vector3() }
        ];

        // Gesture state
        this.currentGesture = GestureType.NONE;
        this.gestureStartData = null;

        // Inertia state
        this.velocity = new THREE.Vector3();
        this.angularVelocity = 0;
        this.scaleVelocity = 0;

        // Terrain reference
        this.terrainMesh = null;

        // Callbacks
        this.onZExaggerationChange = null;

        // Frame timing
        this.lastFrameTime = 0;

        // ARScene reference for pause state
        this.arScene = null;

        // Tool interaction suppression flag
        this.toolInteractionActive = false;

        // Z-exaggeration visual indicator (vertical line between hands)
        this.zExagLine = null;
    }

    /**
     * Initialize hand tracking.
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {ARScene} [arScene] - ARScene reference for pause state
     */
    init(renderer, scene, camera, arScene = null) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.arScene = arScene;

        // Set up hands
        this._setupHands();

        // Set up Z-exaggeration visual indicator
        this._setupZExagIndicator();
    }

    /**
     * Set up WebXR hand tracking.
     */
    _setupHands() {
        const handModelFactory = new XRHandModelFactory();

        // Hand 1 (left or first detected)
        this.hand1 = this.renderer.xr.getHand(0);
        this.handModel1 = handModelFactory.createHandModel(this.hand1, 'mesh');
        this.hand1.add(this.handModel1);
        this.scene.add(this.hand1);

        // Hand 2 (right or second detected)
        this.hand2 = this.renderer.xr.getHand(1);
        this.handModel2 = handModelFactory.createHandModel(this.hand2, 'mesh');
        this.hand2.add(this.handModel2);
        this.scene.add(this.hand2);

        // Listen for pinch events (built-in Three.js XR hand events)
        this.hand1.addEventListener('pinchstart', () => this._onPinchStart(0));
        this.hand1.addEventListener('pinchend', () => this._onPinchEnd(0));
        this.hand2.addEventListener('pinchstart', () => this._onPinchStart(1));
        this.hand2.addEventListener('pinchend', () => this._onPinchEnd(1));
    }

    /**
     * Set up the Z-exaggeration visual indicator (cylinder between hands).
     */
    _setupZExagIndicator() {
        // Use a cylinder for visibility (WebGL often ignores line width)
        const geometry = new THREE.CylinderGeometry(0.003, 0.003, 1, 8);
        const material = new THREE.MeshBasicMaterial({
            color: 0x4fc3f7, // Cyan to match UI theme
            depthTest: false,
            transparent: true,
            opacity: 0.8
        });

        this.zExagLine = new THREE.Mesh(geometry, material);
        this.zExagLine.renderOrder = 999;
        this.zExagLine.visible = false;
        this.scene.add(this.zExagLine);
    }

    /**
     * Handle pinch start.
     */
    _onPinchStart(handIndex) {
        const hand = this.hands[handIndex];
        hand.isPinching = true;
        hand.pinchStartTime = performance.now();
    }

    /**
     * Handle pinch end.
     */
    _onPinchEnd(handIndex) {
        const hand = this.hands[handIndex];
        hand.isPinching = false;

        // Check if gesture should end
        this._checkGestureEnd();
    }

    /**
     * Set the terrain mesh for depth probing.
     * @param {TerrainMesh} terrainMesh
     */
    setTerrainMesh(terrainMesh) {
        this.terrainMesh = terrainMesh;
    }

    /**
     * Create the depth probe label sprite.
     */

    /**
     * Update hand tracking each frame.
     * @param {XRFrame} frame - WebXR frame
     * @param {THREE.Group} modelContainer - The terrain model container
     */
    update(frame, modelContainer) {
        if (!frame || !modelContainer) return;

        // Skip updates when session is paused (XR session blurred/hidden)
        if (this.arScene?.isSessionPaused) return;

        const now = performance.now();
        const deltaTime = this.lastFrameTime > 0 ? (now - this.lastFrameTime) / 1000 : 0.016;
        this.lastFrameTime = now;

        // Update hand positions
        this._updateHandPositions();

        // Determine current gesture
        const gesture = this._detectGesture();

        // Handle gesture change
        if (gesture !== this.currentGesture) {
            this._onGestureChange(gesture, modelContainer);
        }

        // Process current gesture
        if (this.currentGesture === GestureType.NONE) {
            // Apply inertia when no gesture active
            this._applyInertia(modelContainer, deltaTime);
        } else {
            this._processGesture(modelContainer);
        }
    }

    /**
     * Update hand positions from WebXR.
     */
    _updateHandPositions() {
        // Get index fingertip positions
        const hands = [this.hand1, this.hand2];

        for (let i = 0; i < 2; i++) {
            const hand = hands[i];
            if (!hand?.joints) continue;

            const indexTip = hand.joints['index-finger-tip'];
            if (indexTip) {
                this.hands[i].prevPosition.copy(this.hands[i].position);
                indexTip.getWorldPosition(this.hands[i].position);
            }
        }
    }

    /**
     * Detect current gesture based on hand states.
     * @returns {string} GestureType
     */
    /**
     * Set whether a tool interaction is active (suppresses map gestures).
     * @param {boolean} active
     */
    setToolInteractionActive(active) {
        this.toolInteractionActive = active;
    }

    _detectGesture() {
        if (this.toolInteractionActive) return GestureType.NONE;

        const now = performance.now();
        const intentDelay = this.config.pinchIntentDelay;

        // Check which hands are actively pinching (past intent delay)
        const hand0Active = this.hands[0].isPinching &&
            (now - this.hands[0].pinchStartTime) > intentDelay;
        const hand1Active = this.hands[1].isPinching &&
            (now - this.hands[1].pinchStartTime) > intentDelay;

        if (hand0Active && hand1Active) {
            // Two hands pinching - determine if horizontal or vertical
            return this._detectTwoHandGesture();
        } else if (hand0Active || hand1Active) {
            // Single hand pinching
            return GestureType.DRAG;
        }

        return GestureType.NONE;
    }

    /**
     * Detect whether two-hand gesture is horizontal (scale/rotate) or vertical (z-exaggeration).
     * @returns {string} GestureType
     */
    _detectTwoHandGesture() {
        const pos0 = this.hands[0].position;
        const pos1 = this.hands[1].position;

        // Vector between hands
        const delta = new THREE.Vector3().subVectors(pos1, pos0);
        const totalLength = delta.length();

        if (totalLength < 0.01) return GestureType.SCALE_ROTATE;

        const verticalRatio = Math.abs(delta.y) / totalLength;

        if (verticalRatio > this.config.verticalThreshold) {
            return GestureType.Z_EXAGGERATION;
        }

        return GestureType.SCALE_ROTATE;
    }

    /**
     * Handle gesture change.
     */
    _onGestureChange(newGesture, modelContainer) {
        // Store starting data for new gesture
        if (newGesture !== GestureType.NONE) {
            this.gestureStartData = this._captureGestureStartData(modelContainer);
        }

        // Show/hide Z-exaggeration indicator line
        if (this.zExagLine) {
            this.zExagLine.visible = (newGesture === GestureType.Z_EXAGGERATION);
        }

        this.currentGesture = newGesture;
    }

    /**
     * Capture starting data for a gesture.
     */
    _captureGestureStartData(modelContainer) {
        const pos0 = this.hands[0].position.clone();
        const pos1 = this.hands[1].position.clone();
        const distance = pos0.distanceTo(pos1);

        // Angle between hands (horizontal plane)
        const delta = new THREE.Vector3().subVectors(pos1, pos0);
        const angle = Math.atan2(delta.x, delta.z);

        // Vertical distance (absolute, so spreading hands apart always increases)
        const verticalDistance = Math.abs(pos1.y - pos0.y);

        // Compute pivot point in model-local coordinates
        // Use midpoint between hands for more reliable pivot when tracking is unstable
        const midpoint = pos0.clone().add(pos1).multiplyScalar(0.5);
        const worldPivot = midpoint;
        const localPivot = worldPivot.clone().sub(modelContainer.position);
        // Undo model's current rotation to get local coords
        localPivot.applyAxisAngle(new THREE.Vector3(0, 1, 0), -modelContainer.rotation.y);
        // Undo model's current scale
        localPivot.divideScalar(modelContainer.scale.x);

        return {
            hand0Pos: pos0,
            hand1Pos: pos1,
            midpoint: pos0.clone().add(pos1).multiplyScalar(0.5),
            distance,
            angle,
            verticalDistance,
            modelPosition: modelContainer.position.clone(),
            modelRotation: modelContainer.rotation.y,
            modelScale: modelContainer.scale.x,
            localPivot, // Pivot point in model-local coordinates
            zExaggeration: this.terrainMesh ? this.terrainMesh.getZExaggeration() : 1
        };
    }

    /**
     * Check if gesture should end.
     */
    _checkGestureEnd() {
        if (!this.hands[0].isPinching && !this.hands[1].isPinching) {
            // Both hands released - capture velocity for inertia
            if (this.currentGesture === GestureType.DRAG) {
                const activeHand = this.hands[0].isPinching ? 0 : 1;
                this.velocity.subVectors(
                    this.hands[activeHand].position,
                    this.hands[activeHand].prevPosition
                ).multiplyScalar(60); // Convert to velocity per second
            }

            // Hide Z-exaggeration indicator when gesture ends
            if (this.zExagLine) {
                this.zExagLine.visible = false;
            }

            this.currentGesture = GestureType.NONE;
            this.gestureStartData = null;
        }
    }

    /**
     * Reset all gesture state.
     * Call this when the XR session loses focus (e.g., Quest menu opens).
     */
    resetGestureState() {
        // Clear pinch state for both hands
        this.hands[0].isPinching = false;
        this.hands[0].pinchStartTime = 0;
        this.hands[1].isPinching = false;
        this.hands[1].pinchStartTime = 0;

        // Clear gesture state
        this.currentGesture = GestureType.NONE;
        this.gestureStartData = null;

        // Hide Z-exaggeration indicator
        if (this.zExagLine) {
            this.zExagLine.visible = false;
        }

        // Clear inertia
        this.velocity.set(0, 0, 0);
        this.angularVelocity = 0;
        this.scaleVelocity = 0;
    }

    /**
     * Notify that session was paused (resets gesture state).
     * Called when XR session visibility changes to blurred/hidden.
     */
    onSessionPaused() {
        this.resetGestureState();
    }

    /**
     * Process the current gesture.
     */
    _processGesture(modelContainer) {
        switch (this.currentGesture) {
            case GestureType.DRAG:
                this._processDrag(modelContainer);
                break;
            case GestureType.SCALE_ROTATE:
                this._processScaleRotate(modelContainer);
                break;
            case GestureType.Z_EXAGGERATION:
                this._processZExaggeration();
                break;
        }
    }

    /**
     * Process single-hand drag gesture.
     */
    _processDrag(modelContainer) {
        if (!this.gestureStartData) return;

        // Find the active hand
        const activeHandIndex = this.hands[0].isPinching ? 0 : 1;
        const activeHand = this.hands[activeHandIndex];

        // Calculate movement delta
        const startPos = activeHandIndex === 0
            ? this.gestureStartData.hand0Pos
            : this.gestureStartData.hand1Pos;
        const delta = new THREE.Vector3().subVectors(activeHand.position, startPos);

        // Apply distance-based gain
        const distanceToCamera = activeHand.position.distanceTo(this.camera.position);
        const gainFactor = THREE.MathUtils.clamp(
            distanceToCamera / this.config.distanceReference,
            this.config.distanceGainMin,
            this.config.distanceGainMax
        );
        delta.multiplyScalar(gainFactor);

        // Apply to model position
        modelContainer.position.copy(this.gestureStartData.modelPosition).add(delta);
    }

    /**
     * Process two-hand scale and rotate gesture.
     * Transforms are applied around the midpoint between hands (more stable pivot).
     */
    _processScaleRotate(modelContainer) {
        if (!this.gestureStartData) return;

        const pos0 = this.hands[0].position;
        const pos1 = this.hands[1].position;

        // Use midpoint as the pivot point (more stable than single hand)
        const currentMidpoint = pos0.clone().add(pos1).multiplyScalar(0.5);

        // Current distance between hands
        const currentDistance = pos0.distanceTo(pos1);

        // Scale ratio (logarithmic for consistent feel)
        const scaleRatio = currentDistance / this.gestureStartData.distance;
        const logScale = Math.log(scaleRatio);
        const newScale = this.gestureStartData.modelScale * Math.exp(logScale);

        // Clamp scale - allow up to real-world 1:1 scale
        const maxScale = this.terrainMesh ? this.terrainMesh.getRealWorldScale() : 100;
        const clampedScale = THREE.MathUtils.clamp(newScale, 0.1, maxScale);

        // Calculate rotation delta
        const delta = new THREE.Vector3().subVectors(pos1, pos0);
        const currentAngle = Math.atan2(delta.x, delta.z);
        const angleDelta = currentAngle - this.gestureStartData.angle;
        const newRotation = this.gestureStartData.modelRotation + angleDelta;

        // Transform local pivot to world space with new transform
        // This tells us where the pivot point would be after applying new scale/rotation
        const worldPivotOffset = this.gestureStartData.localPivot.clone();
        worldPivotOffset.multiplyScalar(clampedScale); // Apply new scale
        worldPivotOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), newRotation); // Apply new rotation

        // Position model so that the pivot point ends up at the midpoint
        // modelPos + worldPivotOffset = midpoint
        // modelPos = midpoint - worldPivotOffset
        modelContainer.position.copy(currentMidpoint).sub(worldPivotOffset);

        // Apply scale and rotation
        modelContainer.scale.setScalar(clampedScale);
        modelContainer.rotation.y = newRotation;
    }

    /**
     * Process two-hand Z-exaggeration gesture.
     */
    _processZExaggeration() {
        if (!this.gestureStartData || !this.terrainMesh) return;

        const pos0 = this.hands[0].position;
        const pos1 = this.hands[1].position;

        // Update visual indicator cylinder between hands
        if (this.zExagLine) {
            // Position at midpoint
            this.zExagLine.position.set(
                (pos0.x + pos1.x) / 2,
                (pos0.y + pos1.y) / 2,
                (pos0.z + pos1.z) / 2
            );

            // Scale to match distance between hands
            const distance = pos0.distanceTo(pos1);
            this.zExagLine.scale.set(1, distance, 1);

            // Orient to point from pos0 to pos1
            const direction = new THREE.Vector3().subVectors(pos1, pos0).normalize();
            const up = new THREE.Vector3(0, 1, 0);
            const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);
            this.zExagLine.quaternion.copy(quaternion);
        }

        // Current vertical distance (absolute, so spreading hands = positive delta)
        const currentVerticalDistance = Math.abs(pos1.y - pos0.y);
        const verticalDelta = currentVerticalDistance - this.gestureStartData.verticalDistance;

        // Map to z-exaggeration: hands apart = increase, hands together = decrease
        const newExaggeration = this.gestureStartData.zExaggeration +
            verticalDelta * this.config.zExaggerationSensitivity;

        this.terrainMesh.setZExaggeration(newExaggeration);

        if (this.onZExaggerationChange) {
            this.onZExaggerationChange(this.terrainMesh.getZExaggeration());
        }
    }

    /**
     * Apply inertia to model movement.
     */
    _applyInertia(modelContainer, deltaTime) {
        if (!this.config.inertiaEnabled) return;

        // Apply position velocity with damping
        if (this.velocity.lengthSq() > 0.0001) {
            modelContainer.position.add(
                this.velocity.clone().multiplyScalar(deltaTime)
            );
            this.velocity.multiplyScalar(Math.exp(-this.config.positionDamping * deltaTime));
        }
    }

    /**
     * Set callback for Z-exaggeration changes.
     * @param {Function} callback - (exaggeration) => void
     */
    setZExaggerationCallback(callback) {
        this.onZExaggerationChange = callback;
    }

    /**
     * Clean up resources.
     */
    dispose() {
        if (this.hand1) {
            this.scene.remove(this.hand1);
        }
        if (this.hand2) {
            this.scene.remove(this.hand2);
        }
        if (this.zExagLine) {
            this.scene.remove(this.zExagLine);
            this.zExagLine.geometry.dispose();
            this.zExagLine.material.dispose();
            this.zExagLine = null;
        }

        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.terrainMesh = null;
    }
}

/**
 * ToolManager.js - Orchestrator for AR hand tools
 *
 * Connects HandMenu, placed tools, and HandTracking.
 * Manages tool lifecycle: create -> grab -> place -> interact -> dispose.
 */

import * as THREE from 'three';
import { HandMenu, ToolType } from './HandMenu.js';
import { DepthProbeTool } from './DepthProbeTool.js';
import { MeasureTool } from './MeasureTool.js';
import { worldToLocal, localToWorld } from './ToolUtils.js';

const PROXIMITY_THRESHOLD = 0.05; // 8cm in world space

export class ToolManager {
    scene = null;
    camera = null;
    modelContainer = null;
    terrainMesh = null;
    hand0 = null;
    hand1 = null;
    handStates = null;

    // Hand menu
    handMenu = null;

    // Placed tools
    tools = []; // [{tool, type}]

    // Grab state
    grabbedTool = null;
    grabbedPointIndex = -1;
    grabHandIndex = -1;

    // Tool freshly selected from menu (being dragged to placement)
    menuGrabTool = null;
    menuGrabType = null;

    // Interaction state callback
    onInteractionStateChange = null;

    // Track previous interaction active state
    _wasInteractionActive = false;

    // Pinch tracking for edge detection
    _prevPinch = [false, false];

    /**
     * Initialize the tool manager.
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {THREE.Group} modelContainer
     * @param {TerrainMesh} terrainMesh
     * @param {THREE.Object3D} hand0
     * @param {THREE.Object3D} hand1
     * @param {Object[]} handStates
     */
    init(scene, camera, modelContainer, terrainMesh, hand0, hand1, handStates) {
        this.scene = scene;
        this.camera = camera;
        this.modelContainer = modelContainer;
        this.terrainMesh = terrainMesh;
        this.hand0 = hand0;
        this.hand1 = hand1;
        this.handStates = handStates;

        // Create hand menu
        this.handMenu = new HandMenu();
        this.scene.add(this.handMenu.group);

        // Handle tool selection from menu
        this.handMenu.onToolSelected = (toolType, menuWorldPos) => {
            this._onMenuToolSelected(toolType, menuWorldPos);
        };
    }

    /**
     * Update each frame. Called before HandTracking.update().
     * @param {XRFrame} frame
     */
    update(frame) {
        if (!this.scene || !this.modelContainer) return;

        const hands = [this.hand0, this.hand1];
        const isToolActive = this.grabbedTool !== null || this.menuGrabTool !== null;

        // Update hand menu
        if (this.handMenu) {
            this.handMenu.update(
                this.hand0, this.hand1,
                this.handStates,
                this.camera,
                isToolActive
            );
        }

        // Detect pinch edges
        const pinchNow = [
            this.handStates[0]?.isPinching ?? false,
            this.handStates[1]?.isPinching ?? false
        ];
        const pinchStart = [
            pinchNow[0] && !this._prevPinch[0],
            pinchNow[1] && !this._prevPinch[1]
        ];
        const pinchEnd = [
            !pinchNow[0] && this._prevPinch[0],
            !pinchNow[1] && this._prevPinch[1]
        ];

        // Handle menu-spawned tool being dragged
        if (this.menuGrabTool) {
            this._updateMenuGrab(hands, pinchNow, pinchEnd);
        }
        // Handle existing tool grab
        else if (this.grabbedTool) {
            this._updateToolGrab(hands, pinchEnd);
        }
        // Check proximity and start new grabs
        else {
            this._checkProximityAndGrab(hands, pinchStart);
        }

        // Update placed tools (catch per-tool errors so one broken tool
        // doesn't prevent interaction state from being updated)
        for (const entry of this.tools) {
            try {
                entry.tool.updateInWorld(this.terrainMesh, this.modelContainer);
            } catch (e) {
                console.warn('Tool update error:', e);
            }
        }

        // Notify interaction state
        const interactionActive = this.grabbedTool !== null || this.menuGrabTool !== null;
        if (interactionActive !== this._wasInteractionActive) {
            this._wasInteractionActive = interactionActive;
            if (this.onInteractionStateChange) {
                this.onInteractionStateChange(interactionActive);
            }
        }

        this._prevPinch[0] = pinchNow[0];
        this._prevPinch[1] = pinchNow[1];
    }

    /**
     * Handle tool selection from menu.
     */
    _onMenuToolSelected(toolType, menuWorldPos) {
        // Don't create new tools while already interacting with one
        if (this.menuGrabTool || this.grabbedTool) return;

        let tool;
        if (toolType === ToolType.DEPTH_PROBE) {
            tool = new DepthProbeTool();
        } else if (toolType === ToolType.MEASURE) {
            tool = new MeasureTool();
        } else {
            return;
        }

        tool.createVisuals();

        // Position in model-local space
        const localPos = worldToLocal(menuWorldPos, this.modelContainer);
        tool.group.position.copy(localPos);

        this.modelContainer.add(tool.group);

        this.menuGrabTool = tool;
        this.menuGrabType = toolType;
        this.grabHandIndex = this.handMenu.interactingHandIndex;

        // During menu grab we move the entire group (not individual dots),
        // so both MeasureTool dots stay at their default offsets from the
        // drop point. No startGrab() call needed.
    }

    /**
     * Update a tool being dragged from the menu.
     * Moves the entire tool group (not individual interaction points).
     */
    _updateMenuGrab(hands, pinchNow, pinchEnd) {
        const hand = hands[this.grabHandIndex];
        const indexTip = hand?.joints?.['index-finger-tip'];

        // If hand/joint data is missing or pinch ended, release the tool.
        // Pinch events fire independently of joint visibility, so we must
        // check pinchEnd even when joints are unavailable — otherwise the
        // grab state gets stuck forever and suppresses all map gestures.
        const shouldRelease = pinchEnd[this.grabHandIndex] || !indexTip;

        if (indexTip && !shouldRelease) {
            const fingerWorld = new THREE.Vector3();
            indexTip.getWorldPosition(fingerWorld);

            // Move the whole group so all sub-parts (e.g. both MeasureTool
            // dots) stay at their default offsets from the finger
            const localPos = worldToLocal(fingerWorld, this.modelContainer);
            this.menuGrabTool.group.position.copy(localPos);
            return;
        }

        // Release: place or delete
        const fingerWorld = indexTip ? new THREE.Vector3() : null;
        if (indexTip) indexTip.getWorldPosition(fingerWorld);

        if (fingerWorld && this.handMenu?.isInDeleteZone(fingerWorld)) {
            this.menuGrabTool.dispose();
        } else {
            this.tools.push({ tool: this.menuGrabTool, type: this.menuGrabType });
        }

        this.menuGrabTool = null;
        this.menuGrabType = null;
        this.grabHandIndex = -1;
    }

    /**
     * Update an existing tool being grabbed.
     */
    _updateToolGrab(hands, pinchEnd) {
        const hand = hands[this.grabHandIndex];
        const indexTip = hand?.joints?.['index-finger-tip'];

        const shouldRelease = pinchEnd[this.grabHandIndex] || !indexTip;

        if (indexTip && !shouldRelease) {
            const fingerWorld = new THREE.Vector3();
            indexTip.getWorldPosition(fingerWorld);

            // Update tool position
            const localPos = worldToLocal(fingerWorld, this.modelContainer);
            this.grabbedTool.updateGrab(localPos);

            // Show/hide delete icon based on proximity to menu
            const nearDelete = this.handMenu?.isInDeleteZone(fingerWorld) ?? false;
            if (this.handMenu) {
                this.handMenu.showDeleteIcon(nearDelete);
            }
            return;
        }

        // Release: check delete zone if we have finger position
        const fingerWorld = indexTip ? new THREE.Vector3() : null;
        if (indexTip) indexTip.getWorldPosition(fingerWorld);
        const nearDelete = fingerWorld && this.handMenu?.isInDeleteZone(fingerWorld);

        if (nearDelete) {
            const idx = this.tools.findIndex(e => e.tool === this.grabbedTool);
            if (idx >= 0) this.tools.splice(idx, 1);
            this.grabbedTool.dispose();
        } else {
            this.grabbedTool.endGrab(this.terrainMesh);
        }

        this.grabbedTool = null;
        this.grabbedPointIndex = -1;
        this.grabHandIndex = -1;

        if (this.handMenu) this.handMenu.showDeleteIcon(false);
    }

    /**
     * Clear highlight state on every interaction point of every placed tool.
     */
    _clearAllHighlights() {
        for (const entry of this.tools) {
            const points = entry.tool.getInteractionPoints();
            for (let pi = 0; pi < points.length; pi++) {
                entry.tool.setHighlight(pi, false);
            }
        }
    }

    /**
     * Find the nearest interaction point (across all placed tools) to a world-
     * space position.
     * @param {THREE.Vector3} fingerWorld
     * @returns {{ tool: object, pointIndex: number } | null}
     */
    _findNearestInteractionPoint(fingerWorld) {
        let nearestTool = null;
        let nearestPointIdx = -1;
        let nearestDist = PROXIMITY_THRESHOLD;

        for (const entry of this.tools) {
            const points = entry.tool.getInteractionPoints();
            for (let pi = 0; pi < points.length; pi++) {
                const pointWorld = localToWorld(points[pi], this.modelContainer);
                const dist = fingerWorld.distanceTo(pointWorld);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestTool = entry.tool;
                    nearestPointIdx = pi;
                }
            }
        }

        return nearestTool ? { tool: nearestTool, pointIndex: nearestPointIdx } : null;
    }

    /**
     * Check proximity of hands to placed tools and start grabs.
     */
    _checkProximityAndGrab(hands, pinchStart) {
        this._clearAllHighlights();

        // For each hand, find nearest interaction point
        for (let hi = 0; hi < 2; hi++) {
            const hand = hands[hi];
            if (!hand?.joints) continue;

            const indexTip = hand.joints['index-finger-tip'];
            if (!indexTip) continue;

            const fingerWorld = new THREE.Vector3();
            indexTip.getWorldPosition(fingerWorld);

            const nearest = this._findNearestInteractionPoint(fingerWorld);
            if (!nearest) continue;

            nearest.tool.setHighlight(nearest.pointIndex, true);

            // Start grab on pinch
            if (pinchStart[hi]) {
                nearest.tool.startGrab(nearest.pointIndex);
                this.grabbedTool = nearest.tool;
                this.grabbedPointIndex = nearest.pointIndex;
                this.grabHandIndex = hi;
                break; // only one grab at a time
            }
        }
    }

    /**
     * Re-attach tool visuals to a new modelContainer after scene rebuild.
     * @param {THREE.Group} newModelContainer
     */
    reattach(newModelContainer) {
        this.modelContainer = newModelContainer;

        for (const entry of this.tools) {
            if (entry.tool.group.parent) {
                entry.tool.group.parent.remove(entry.tool.group);
            }
            newModelContainer.add(entry.tool.group);
        }
    }

    /**
     * Reset state (e.g., when session pauses).
     */
    reset() {
        if (this.menuGrabTool) {
            this.menuGrabTool.dispose();
            this.menuGrabTool = null;
            this.menuGrabType = null;
        }

        if (this.grabbedTool) {
            this.grabbedTool.endGrab();
            this.grabbedTool = null;
        }

        this.grabbedPointIndex = -1;
        this.grabHandIndex = -1;
        this._prevPinch = [false, false];

        if (this.onInteractionStateChange && this._wasInteractionActive) {
            this._wasInteractionActive = false;
            this.onInteractionStateChange(false);
        }
    }

    /**
     * Dispose of all resources.
     */
    dispose() {
        for (const entry of this.tools) {
            entry.tool.dispose();
        }
        this.tools = [];

        if (this.menuGrabTool) {
            this.menuGrabTool.dispose();
            this.menuGrabTool = null;
        }

        if (this.handMenu) {
            this.handMenu.dispose();
            this.handMenu = null;
        }

        this.scene = null;
        this.camera = null;
        this.modelContainer = null;
        this.terrainMesh = null;
        this.hand0 = null;
        this.hand1 = null;
        this.handStates = null;
    }
}

/**
 * DepthProbeTool.js - Interactive depth probe for AR terrain
 *
 * Displays a vertical probe that shows elevation and depth-below-reference
 * at a point on the terrain. Can be grabbed and repositioned.
 */

import * as THREE from 'three';
import { createTextSprite, updateTextSprite, worldToLocal, localToWorld, throttle, clampedElementScale } from './ToolUtils.js';

export class DepthProbeTool {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'depthProbe';

        // Visual components (created lazily)
        this.label = null;
        this.line = null;
        this.contactSphere = null;
        this.highlightRing = null;

        // State
        this.isGrabbed = false;
        this.highlighted = false;

        // Throttled terrain query
        this._throttledUpdate = throttle(this._queryTerrain.bind(this), 100); // 10Hz

        // Cached values
        this._lastElevation = null;
        this._lastDepth = null;
    }

    /**
     * Create the visual elements.
     */
    createVisuals() {
        // Label sprite
        this.label = createTextSprite('--', {
            fontSize: 36,
            color: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0.7)',
            canvasWidth: 512,
            canvasHeight: 96,
            spriteScale: 0.12
        });
        this.label.position.set(0, 0.06, 0);
        this.group.add(this.label);

        // Vertical line from label down to terrain
        const lineGeometry = new THREE.BufferGeometry();
        const linePositions = new Float32Array([0, 0.05, 0, 0, 0, 0]);
        lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
        this.line = new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.8,
            depthTest: false
        }));
        this.group.add(this.line);

        // Contact sphere at terrain surface
        const sphereGeo = new THREE.SphereGeometry(0.004, 12, 12);
        const sphereMat = new THREE.MeshBasicMaterial({
            color: 0x00e5ff,
            depthTest: false
        });
        this.contactSphere = new THREE.Mesh(sphereGeo, sphereMat);
        this.group.add(this.contactSphere);

        // Highlight ring (shown when nearby)
        const ringGeo = new THREE.RingGeometry(0.008, 0.014, 24);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x00e5ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.6,
            depthTest: false
        });
        this.highlightRing = new THREE.Mesh(ringGeo, ringMat);
        this.highlightRing.rotation.x = -Math.PI / 2;
        this.highlightRing.visible = false;
        this.group.add(this.highlightRing);
    }

    /**
     * Update the probe's position and label while placed in the world.
     * @param {TerrainMesh} terrainMesh
     * @param {THREE.Group} modelContainer
     */
    updateInWorld(terrainMesh, modelContainer) {
        if (!terrainMesh || this.isGrabbed) return;

        // Clamp interactive element sizes to real-world bounds
        if (modelContainer) {
            const cs = modelContainer.scale.x;
            const sphereS = clampedElementScale(0.004, cs, 0.005, 0.025);
            this.contactSphere.scale.setScalar(sphereS);
            this.highlightRing.scale.setScalar(sphereS);

            const labelBase = 0.12;
            const labelS = clampedElementScale(labelBase, cs, 0.04, 0.18);
            const aspect = 512 / 96;
            this.label.scale.set(labelBase * labelS, labelBase / aspect * labelS, 1);
        }

        this._throttledUpdate(terrainMesh, modelContainer);
    }

    /**
     * Query terrain for elevation/depth and update visuals.
     */
    _queryTerrain(terrainMesh) {
        const localPos = this.group.position;

        // Get terrain height at this local position
        const terrainY = terrainMesh.getHeightAtLocalPosition(localPos.x, localPos.z);

        // Snap contact sphere to terrain surface
        this.contactSphere.position.set(0, terrainY - localPos.y, 0);
        this.highlightRing.position.set(0, terrainY - localPos.y + 0.001, 0);

        // Update vertical line
        const linePositions = this.line.geometry.attributes.position.array;
        linePositions[1] = 0.05; // top (at label)
        linePositions[4] = terrainY - localPos.y; // bottom (at terrain)
        this.line.geometry.attributes.position.needsUpdate = true;

        // Get raw elevation for display
        const halfWidth = terrainMesh.modelWidth / 2;
        const halfHeight = terrainMesh.modelHeight / 2;
        const u = (localPos.x + halfWidth) / terrainMesh.modelWidth;
        const v = (localPos.z + halfHeight) / terrainMesh.modelHeight;

        if (u < 0 || u > 1 || v < 0 || v > 1) {
            updateTextSprite(this.label, 'Off map');
            this._lastElevation = null;
            this._lastDepth = null;
            return;
        }

        const elevation = terrainMesh._sampleElevation(u, v);
        if (Number.isFinite(elevation)) {
            this._lastElevation = elevation;
            const depth = terrainMesh.referenceElevation - elevation;
            this._lastDepth = depth;

            const elevStr = elevation.toFixed(1);
            const depthStr = depth.toFixed(1);
            updateTextSprite(this.label, `${elevStr}m (${depthStr}m below ref)`);
        } else {
            updateTextSprite(this.label, 'No data');
            this._lastElevation = null;
            this._lastDepth = null;
        }
    }

    /**
     * Get the interaction points in model-local space.
     * @returns {THREE.Vector3[]} Array with one point (the probe position)
     */
    getInteractionPoints() {
        return [this.group.position.clone()];
    }

    /**
     * Set highlight state for an interaction point.
     * @param {number} idx - Point index (always 0 for depth probe)
     * @param {boolean} highlighted
     */
    setHighlight(idx, highlighted) {
        this.highlighted = highlighted;
        if (this.highlightRing) {
            this.highlightRing.visible = highlighted;
        }
    }

    /**
     * Start grabbing the probe.
     * @param {number} idx - Point index (always 0)
     */
    startGrab(idx) {
        this.isGrabbed = true;
        if (this.highlightRing) this.highlightRing.visible = false;
    }

    /**
     * Update position while grabbed.
     * Tracks XZ from the pinch center; Y follows along so the
     * probe visually stays at the finger. On release, endGrab()
     * snaps Y to terrain.
     * @param {THREE.Vector3} localPos - New position in model-local space
     */
    updateGrab(localPos) {
        this.group.position.copy(localPos);
    }

    /**
     * End grab — snap the probe down to the terrain surface.
     * @param {TerrainMesh} [terrainMesh] - If provided, snaps Y to terrain height
     */
    endGrab(terrainMesh) {
        this.isGrabbed = false;
        if (terrainMesh) {
            const pos = this.group.position;
            pos.y = terrainMesh.getHeightAtLocalPosition(pos.x, pos.z);
        }
    }

    /**
     * Dispose of all resources.
     */
    dispose() {
        if (this.group.parent) {
            this.group.parent.remove(this.group);
        }

        this.group.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (child.material.map) child.material.map.dispose();
                child.material.dispose();
            }
        });
    }
}

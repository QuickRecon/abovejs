/**
 * MeasureTool.js - Interactive distance measurement for AR terrain
 *
 * Two draggable endpoints connected by a line, displaying horizontal
 * and 3D distances between them in real-world units.
 */

import * as THREE from 'three';
import { createTextSprite, updateTextSprite, throttle, clampedElementScale } from './ToolUtils.js';

export class MeasureTool {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'measureTool';

        // Visual components
        this.dotA = null;
        this.dotB = null;
        this.line = null;
        this.label = null;

        // State
        this.grabbedIndex = -1; // -1 = not grabbed, 0 = dotA, 1 = dotB

        // Positions in group-local space (relative to group origin)
        this.posA = new THREE.Vector3(-0.02, 0, 0);
        this.posB = new THREE.Vector3(0.02, 0, 0);

        // Throttled terrain query
        this._throttledUpdate = throttle(this._computeDistances.bind(this), 100);
    }

    /**
     * Create the visual elements.
     */
    createVisuals() {
        const dotGeo = new THREE.SphereGeometry(0.008, 12, 12);
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xff4444, depthTest: false });

        // Dot A
        this.dotA = new THREE.Mesh(dotGeo, dotMat.clone());
        this.dotA.position.copy(this.posA);
        this.group.add(this.dotA);

        // Dot B
        this.dotB = new THREE.Mesh(dotGeo, dotMat.clone());
        this.dotB.position.copy(this.posB);
        this.group.add(this.dotB);

        // Connecting line
        const lineGeo = new THREE.BufferGeometry();
        const linePositions = new Float32Array(6);
        lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
        this.line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.8,
            depthTest: false
        }));
        this.group.add(this.line);

        // Label at midpoint - tall enough for 3 lines of text
        this.label = createTextSprite('--', {
            fontSize: 32,
            color: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0.7)',
            canvasWidth: 512,
            canvasHeight: 192,
            spriteScale: 0.14
        });
        this.group.add(this.label);

        // Highlight rings for each dot
        const ringGeo = new THREE.RingGeometry(0.012, 0.020, 24);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xff4444,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.6,
            depthTest: false
        });

        this.highlightA = new THREE.Mesh(ringGeo, ringMat.clone());
        this.highlightA.rotation.x = -Math.PI / 2;
        this.highlightA.visible = false;
        this.group.add(this.highlightA);

        this.highlightB = new THREE.Mesh(ringGeo, ringMat.clone());
        this.highlightB.rotation.x = -Math.PI / 2;
        this.highlightB.visible = false;
        this.group.add(this.highlightB);

        this._updateLineAndLabel();
    }

    /**
     * Update the tool each frame while placed in the world.
     * @param {TerrainMesh} terrainMesh
     * @param {THREE.Group} modelContainer
     */
    updateInWorld(terrainMesh, modelContainer) {
        if (!terrainMesh) return;

        // Clamp interactive element sizes to real-world bounds
        if (modelContainer) {
            const cs = modelContainer.scale.x;
            const dotS = clampedElementScale(0.008, cs, 0.005, 0.025);
            this.dotA.scale.setScalar(dotS);
            this.dotB.scale.setScalar(dotS);
            this.highlightA.scale.setScalar(dotS);
            this.highlightB.scale.setScalar(dotS);

            const labelBase = 0.14;
            const labelS = clampedElementScale(labelBase, cs, 0.04, 0.18);
            const aspect = 512 / 192;
            this.label.scale.set(labelBase * labelS, labelBase / aspect * labelS, 1);
        }

        // Snap dots to terrain surface, but skip the currently grabbed dot
        // so terrain-snapping doesn't fight with the grab position
        const groupPos = this.group.position;

        // Snap non-grabbed dots to terrain. Grabbed dots are positioned
        // by updateGrab() to follow the pinch center — don't overwrite.
        if (this.grabbedIndex !== 0) {
            const worldAx = groupPos.x + this.posA.x;
            const worldAz = groupPos.z + this.posA.z;
            const yA = terrainMesh.getHeightAtLocalPosition(worldAx, worldAz);
            this.dotA.position.set(this.posA.x, yA - groupPos.y, this.posA.z);
        }

        if (this.grabbedIndex !== 1) {
            const worldBx = groupPos.x + this.posB.x;
            const worldBz = groupPos.z + this.posB.z;
            const yB = terrainMesh.getHeightAtLocalPosition(worldBx, worldBz);
            this.dotB.position.set(this.posB.x, yB - groupPos.y, this.posB.z);
        }

        // Update highlights to match dot positions
        this.highlightA.position.copy(this.dotA.position);
        this.highlightA.position.y += 0.001;
        this.highlightB.position.copy(this.dotB.position);
        this.highlightB.position.y += 0.001;

        this._updateLineAndLabel();
        this._throttledUpdate(terrainMesh);
    }

    /**
     * Update line geometry and label position.
     */
    _updateLineAndLabel() {
        if (!this.line) return;

        const posArr = this.line.geometry.attributes.position.array;
        posArr[0] = this.dotA.position.x;
        posArr[1] = this.dotA.position.y;
        posArr[2] = this.dotA.position.z;
        posArr[3] = this.dotB.position.x;
        posArr[4] = this.dotB.position.y;
        posArr[5] = this.dotB.position.z;
        this.line.geometry.attributes.position.needsUpdate = true;

        // Label at midpoint, slightly above
        if (this.label) {
            this.label.position.set(
                (this.dotA.position.x + this.dotB.position.x) / 2,
                Math.max(this.dotA.position.y, this.dotB.position.y) + 0.04,
                (this.dotA.position.z + this.dotB.position.z) / 2
            );
        }
    }

    /**
     * Compute and display distances.
     * Renders 3 lines: horizontal, height difference, and 3D distance.
     * @param {TerrainMesh} terrainMesh
     */
    _computeDistances(terrainMesh) {
        const groupPos = this.group.position;
        const scale = terrainMesh.realWorldScale;

        // Model-local positions of each dot
        const ax = groupPos.x + this.posA.x;
        const az = groupPos.z + this.posA.z;
        const bx = groupPos.x + this.posB.x;
        const bz = groupPos.z + this.posB.z;

        // Horizontal distance in model space -> real-world
        const dx = bx - ax;
        const dz = bz - az;
        const hDistModel = Math.sqrt(dx * dx + dz * dz);
        const hDist = hDistModel * scale;

        // Get raw elevations for 3D distance and height difference
        const halfW = terrainMesh.modelWidth / 2;
        const halfH = terrainMesh.modelHeight / 2;
        const uA = (ax + halfW) / terrainMesh.modelWidth;
        const vA = (az + halfH) / terrainMesh.modelHeight;
        const uB = (bx + halfW) / terrainMesh.modelWidth;
        const vB = (bz + halfH) / terrainMesh.modelHeight;

        if (uA >= 0 && uA <= 1 && vA >= 0 && vA <= 1 &&
            uB >= 0 && uB <= 1 && vB >= 0 && vB <= 1) {
            const elevA = terrainMesh._sampleElevation(uA, vA);
            const elevB = terrainMesh._sampleElevation(uB, vB);

            if (Number.isFinite(elevA) && Number.isFinite(elevB)) {
                const elevDiff = elevB - elevA;
                const dist3D = Math.sqrt(hDist * hDist + elevDiff * elevDiff);
                this._renderLabel(hDist, elevDiff, dist3D);
            } else {
                this._renderLabel(hDist, null, null);
            }
        } else {
            this._renderLabel(hDist, null, null);
        }
    }

    /**
     * Render 3-line distance label directly to canvas.
     * @param {number} hDist - Horizontal distance in meters
     * @param {number|null} elevDiff - Height difference in meters (B - A)
     * @param {number|null} dist3D - 3D distance in meters
     */
    _renderLabel(hDist, elevDiff, dist3D) {
        const canvas = this.label.userData.canvas;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Background
        const pad = 10;
        const r = 14;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.moveTo(pad + r, pad);
        ctx.lineTo(w - pad - r, pad);
        ctx.quadraticCurveTo(w - pad, pad, w - pad, pad + r);
        ctx.lineTo(w - pad, h - pad - r);
        ctx.quadraticCurveTo(w - pad, h - pad, w - pad - r, h - pad);
        ctx.lineTo(pad + r, h - pad);
        ctx.quadraticCurveTo(pad, h - pad, pad, h - pad - r);
        ctx.lineTo(pad, pad + r);
        ctx.quadraticCurveTo(pad, pad, pad + r, pad);
        ctx.closePath();
        ctx.fill();

        // Text lines
        ctx.font = 'bold 30px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const lineH = h / 3;
        const cx = w / 2;

        // Line 1: Horizontal
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`H: ${this._formatDist(hDist)}`, cx, lineH * 0.5);

        // Line 2: Height difference
        if (elevDiff !== null) {
            const sign = elevDiff >= 0 ? '+' : '';
            ctx.fillStyle = '#aaaaaa';
            ctx.fillText(`\u0394H: ${sign}${this._formatDist(Math.abs(elevDiff))}`, cx, lineH * 1.5);
        }

        // Line 3: 3D distance
        if (dist3D !== null) {
            ctx.fillStyle = '#4fc3f7';
            ctx.fillText(`3D: ${this._formatDist(dist3D)}`, cx, lineH * 2.5);
        }

        this.label.userData.texture.needsUpdate = true;
    }

    /**
     * Format a distance value with appropriate units.
     * @param {number} meters
     * @returns {string}
     */
    _formatDist(meters) {
        if (meters < 1) return `${(meters * 100).toFixed(1)}cm`;
        if (meters < 1000) return `${meters.toFixed(1)}m`;
        return `${(meters / 1000).toFixed(2)}km`;
    }

    /**
     * Get interaction points in model-local space (absolute, not group-relative).
     * Uses the actual visual dot positions (including terrain-snapped Y)
     * so proximity checks match what the user sees.
     * @returns {THREE.Vector3[]} [pointA, pointB]
     */
    getInteractionPoints() {
        const groupPos = this.group.position;
        return [
            new THREE.Vector3(
                groupPos.x + this.dotA.position.x,
                groupPos.y + this.dotA.position.y,
                groupPos.z + this.dotA.position.z
            ),
            new THREE.Vector3(
                groupPos.x + this.dotB.position.x,
                groupPos.y + this.dotB.position.y,
                groupPos.z + this.dotB.position.z
            )
        ];
    }

    /**
     * Set highlight state for a specific dot.
     * @param {number} idx - 0 = dotA, 1 = dotB
     * @param {boolean} highlighted
     */
    setHighlight(idx, highlighted) {
        if (idx === 0 && this.highlightA) this.highlightA.visible = highlighted;
        if (idx === 1 && this.highlightB) this.highlightB.visible = highlighted;
    }

    /**
     * Start grabbing a dot.
     * @param {number} idx - 0 = dotA, 1 = dotB
     */
    startGrab(idx) {
        this.grabbedIndex = idx;
        this.setHighlight(idx, false);
    }

    /**
     * Update position of the grabbed dot.
     * Tracks XZ and Y from the pinch center so the dot follows the finger.
     * @param {THREE.Vector3} localPos - New position in model-local space
     */
    updateGrab(localPos) {
        const groupPos = this.group.position;
        const relY = localPos.y - groupPos.y;
        if (this.grabbedIndex === 0) {
            this.posA.set(localPos.x - groupPos.x, 0, localPos.z - groupPos.z);
            this.dotA.position.set(this.posA.x, relY, this.posA.z);
        } else if (this.grabbedIndex === 1) {
            this.posB.set(localPos.x - groupPos.x, 0, localPos.z - groupPos.z);
            this.dotB.position.set(this.posB.x, relY, this.posB.z);
        }
        this._updateLineAndLabel();
    }

    /**
     * End grab. Terrain snapping in the next updateInWorld() call
     * will drop the dot onto the surface.
     */
    endGrab() {
        this.grabbedIndex = -1;
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

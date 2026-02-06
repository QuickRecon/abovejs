/**
 * ProfileTool.js - Interactive elevation profile for AR terrain
 *
 * Displays an elevation profile between two draggable endpoints,
 * with a movable marker showing distance and elevation along the
 * terrain-following path.
 */

import * as THREE from 'three';
import { createTextSprite, throttle, clampedElementScale } from './ToolUtils.js';

const NUM_SAMPLES = 80;

export class ProfileTool {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'profileTool';

        // Visual components
        this.dotA = null;
        this.dotB = null;
        this.marker = null;
        this.profileLine = null;
        this.label = null;

        // Highlight rings
        this.highlightA = null;
        this.highlightB = null;
        this.highlightMarker = null;

        // State
        this.grabbedIndex = -1; // -1=none, 0=dotA, 1=dotB, 2=marker

        // Positions in group-local space (XZ only, Y computed from terrain)
        this.posA = new THREE.Vector3(-0.02, 0, 0);
        this.posB = new THREE.Vector3(0.02, 0, 0);

        // Profile data
        this.profilePoints = []; // [{pos: Vector3, distFromA: number, elevation: number, t: number}]
        this.totalDistance = 0;
        this.markerT = 0.5; // Marker position [0,1] along profile

        // Throttled profile computation
        this._throttledComputeProfile = throttle(this._computeProfile.bind(this), 100);

        // Throttled label rendering (elevation interpolation)
        this._throttledRenderLabel = throttle(this._renderLabel.bind(this), 100);
    }

    /**
     * Create the visual elements.
     */
    createVisuals() {
        // Endpoint dots (green, 8mm) - distinct from red MeasureTool
        const dotGeo = new THREE.SphereGeometry(0.008, 12, 12);
        const dotMat = new THREE.MeshBasicMaterial({ color: 0x4caf50, depthTest: false });

        this.dotA = new THREE.Mesh(dotGeo, dotMat.clone());
        this.dotA.position.copy(this.posA);
        this.group.add(this.dotA);

        this.dotB = new THREE.Mesh(dotGeo, dotMat.clone());
        this.dotB.position.copy(this.posB);
        this.group.add(this.dotB);

        // Marker (gold, 6mm)
        const markerGeo = new THREE.SphereGeometry(0.006, 12, 12);
        const markerMat = new THREE.MeshBasicMaterial({ color: 0xffc107, depthTest: false });
        this.marker = new THREE.Mesh(markerGeo, markerMat);
        this.group.add(this.marker);

        // Profile line (cyan) - pre-allocate buffer for NUM_SAMPLES + 1 points
        const lineGeo = new THREE.BufferGeometry();
        const linePositions = new Float32Array((NUM_SAMPLES + 1) * 3);
        lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
        this.profileLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
            color: 0x00e5ff,
            transparent: true,
            opacity: 0.9,
            depthTest: false
        }));
        // Disable frustum culling - line positions update dynamically and
        // bounding sphere would need constant recomputation
        this.profileLine.frustumCulled = false;
        this.group.add(this.profileLine);

        // Label (512x192 for 3 lines)
        this.label = createTextSprite('--', {
            fontSize: 32,
            color: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0.7)',
            canvasWidth: 512,
            canvasHeight: 192,
            spriteScale: 0.14
        });
        this.group.add(this.label);

        // Highlight rings for endpoints (green to match endpoints)
        const ringGeo = new THREE.RingGeometry(0.012, 0.02, 24);
        const ringMatGreen = new THREE.MeshBasicMaterial({
            color: 0x4caf50,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.6,
            depthTest: false
        });

        this.highlightA = new THREE.Mesh(ringGeo, ringMatGreen.clone());
        this.highlightA.rotation.x = -Math.PI / 2;
        this.highlightA.visible = false;
        this.group.add(this.highlightA);

        this.highlightB = new THREE.Mesh(ringGeo, ringMatGreen.clone());
        this.highlightB.rotation.x = -Math.PI / 2;
        this.highlightB.visible = false;
        this.group.add(this.highlightB);

        // Highlight ring for marker (gold)
        const ringMatGold = new THREE.MeshBasicMaterial({
            color: 0xffc107,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.6,
            depthTest: false
        });
        this.highlightMarker = new THREE.Mesh(ringGeo.clone(), ringMatGold);
        this.highlightMarker.rotation.x = -Math.PI / 2;
        this.highlightMarker.visible = false;
        this.group.add(this.highlightMarker);
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

            const markerS = clampedElementScale(0.006, cs, 0.004, 0.02);
            this.marker.scale.setScalar(markerS);
            this.highlightMarker.scale.setScalar(markerS);

            const labelBase = 0.14;
            const labelS = clampedElementScale(labelBase, cs, 0.04, 0.18);
            const aspect = 512 / 192;
            this.label.scale.set(labelBase * labelS, labelBase / aspect * labelS, 1);
        }

        const groupPos = this.group.position;

        // Snap non-grabbed endpoints to terrain
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

        // Update endpoint highlights
        this.highlightA.position.copy(this.dotA.position);
        this.highlightA.position.y += 0.001;
        this.highlightB.position.copy(this.dotB.position);
        this.highlightB.position.y += 0.001;

        // Compute profile (throttled)
        this._throttledComputeProfile(terrainMesh);

        // Update line geometry
        this._updateLineGeometry();

        // Update marker position
        this._updateMarkerPosition();

        // Update marker highlight
        this.highlightMarker.position.copy(this.marker.position);
        this.highlightMarker.position.y += 0.001;

        // Render label (throttled for performance during drags)
        this._throttledRenderLabel(terrainMesh);
    }

    /**
     * Compute the elevation profile between A and B.
     * @param {TerrainMesh} terrainMesh
     */
    _computeProfile(terrainMesh) {
        const groupPos = this.group.position;

        // World positions of endpoints
        const ax = groupPos.x + this.posA.x;
        const az = groupPos.z + this.posA.z;
        const bx = groupPos.x + this.posB.x;
        const bz = groupPos.z + this.posB.z;

        const halfW = terrainMesh.modelWidth / 2;
        const halfH = terrainMesh.modelHeight / 2;

        this.profilePoints = [];
        let cumulativeDistance = 0;
        let prevPos = null;

        for (let i = 0; i <= NUM_SAMPLES; i++) {
            const t = i / NUM_SAMPLES;
            const x = ax + (bx - ax) * t;
            const z = az + (bz - az) * t;

            // Get UV coordinates for elevation sampling
            const u = (x + halfW) / terrainMesh.modelWidth;
            const v = (z + halfH) / terrainMesh.modelHeight;

            // Get terrain height at this point
            const y = terrainMesh.getHeightAtLocalPosition(x, z);

            // Get raw elevation for display
            let elevation = null;
            if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
                const elev = terrainMesh._sampleElevation(u, v);
                if (Number.isFinite(elev)) {
                    elevation = elev;
                }
            }

            // Position in group-local coordinates
            const pos = new THREE.Vector3(x - groupPos.x, y - groupPos.y, z - groupPos.z);

            // Compute cumulative distance along the profile
            if (prevPos) {
                // Distance in real-world units
                const dx = pos.x - prevPos.x;
                const dy = pos.y - prevPos.y;
                const dz = pos.z - prevPos.z;
                const segmentDist = Math.hypot(dx, dy, dz) * terrainMesh.realWorldScale;
                cumulativeDistance += segmentDist;
            }

            this.profilePoints.push({
                pos,
                distFromA: cumulativeDistance,
                elevation,
                t
            });

            prevPos = pos;
        }

        this.totalDistance = cumulativeDistance;
    }

    /**
     * Update the profile line geometry from cached points.
     */
    _updateLineGeometry() {
        if (!this.profileLine || this.profilePoints.length === 0) return;

        const posArr = this.profileLine.geometry.attributes.position.array;

        for (let i = 0; i < this.profilePoints.length; i++) {
            const pt = this.profilePoints[i];
            posArr[i * 3] = pt.pos.x;
            posArr[i * 3 + 1] = pt.pos.y;
            posArr[i * 3 + 2] = pt.pos.z;
        }

        // Fill remaining buffer with last point (if profile has fewer than NUM_SAMPLES + 1 points)
        const lastPt = this.profilePoints[this.profilePoints.length - 1];
        for (let i = this.profilePoints.length; i <= NUM_SAMPLES; i++) {
            posArr[i * 3] = lastPt.pos.x;
            posArr[i * 3 + 1] = lastPt.pos.y;
            posArr[i * 3 + 2] = lastPt.pos.z;
        }

        this.profileLine.geometry.attributes.position.needsUpdate = true;
        this.profileLine.geometry.setDrawRange(0, this.profilePoints.length);
    }

    /**
     * Update marker position based on markerT.
     */
    _updateMarkerPosition() {
        if (!this.marker || this.profilePoints.length < 2) return;

        // Find the target distance along the profile
        const targetDist = this.markerT * this.totalDistance;

        // Find the two points that bracket this distance
        let idx = 0;
        for (let i = 1; i < this.profilePoints.length; i++) {
            if (this.profilePoints[i].distFromA >= targetDist) {
                idx = i - 1;
                break;
            }
            idx = i - 1;
        }

        // Interpolate between the two bracketing points
        const pt0 = this.profilePoints[idx];
        const pt1 = this.profilePoints[Math.min(idx + 1, this.profilePoints.length - 1)];

        const segmentLength = pt1.distFromA - pt0.distFromA;
        let localT = 0;
        if (segmentLength > 0) {
            localT = (targetDist - pt0.distFromA) / segmentLength;
        }

        this.marker.position.lerpVectors(pt0.pos, pt1.pos, localT);
    }

    /**
     * Render the label with distances from A/B and elevation.
     * @param {TerrainMesh} terrainMesh
     */
    _renderLabel(terrainMesh) {
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

        // Calculate distances and elevation at marker
        const distFromA = this.markerT * this.totalDistance;
        const distFromB = this.totalDistance - distFromA;

        // Get elevation at marker
        let elevationStr = '--';
        if (this.profilePoints.length >= 2) {
            const targetDist = this.markerT * this.totalDistance;
            let idx = 0;
            for (let i = 1; i < this.profilePoints.length; i++) {
                if (this.profilePoints[i].distFromA >= targetDist) {
                    idx = i - 1;
                    break;
                }
                idx = i - 1;
            }

            const pt0 = this.profilePoints[idx];
            const pt1 = this.profilePoints[Math.min(idx + 1, this.profilePoints.length - 1)];

            // Interpolate elevation
            if (pt0.elevation !== null && pt1.elevation !== null) {
                const segmentLength = pt1.distFromA - pt0.distFromA;
                let localT = 0;
                if (segmentLength > 0) {
                    localT = (targetDist - pt0.distFromA) / segmentLength;
                }
                const elev = pt0.elevation + (pt1.elevation - pt0.elevation) * localT;
                elevationStr = `${elev.toFixed(1)}m`;
            }
        }

        // Text lines
        ctx.font = 'bold 30px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const lineH = h / 3;
        const cx = w / 2;

        // Line 1: From A
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`From A: ${this._formatDist(distFromA)}`, cx, lineH * 0.5);

        // Line 2: From B
        ctx.fillStyle = '#aaaaaa';
        ctx.fillText(`From B: ${this._formatDist(distFromB)}`, cx, lineH * 1.5);

        // Line 3: Elevation
        ctx.fillStyle = '#ffc107';
        ctx.fillText(`Elev: ${elevationStr}`, cx, lineH * 2.5);

        this.label.userData.texture.needsUpdate = true;

        // Position label above the marker
        this.label.position.set(
            this.marker.position.x,
            this.marker.position.y + 0.04,
            this.marker.position.z
        );
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
     * Get interaction points in model-local space.
     * @returns {THREE.Vector3[]} [pointA, pointB, marker]
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
            ),
            new THREE.Vector3(
                groupPos.x + this.marker.position.x,
                groupPos.y + this.marker.position.y,
                groupPos.z + this.marker.position.z
            )
        ];
    }

    /**
     * Set highlight state for a specific interaction point.
     * @param {number} idx - 0=dotA, 1=dotB, 2=marker
     * @param {boolean} highlighted
     */
    setHighlight(idx, highlighted) {
        if (idx === 0 && this.highlightA) this.highlightA.visible = highlighted;
        if (idx === 1 && this.highlightB) this.highlightB.visible = highlighted;
        if (idx === 2 && this.highlightMarker) this.highlightMarker.visible = highlighted;
    }

    /**
     * Start grabbing an interaction point.
     * @param {number} idx - 0=dotA, 1=dotB, 2=marker
     */
    startGrab(idx) {
        this.grabbedIndex = idx;
        this.setHighlight(idx, false);
    }

    /**
     * Update position of the grabbed element.
     * @param {THREE.Vector3} localPos - New position in model-local space
     */
    updateGrab(localPos) {
        const groupPos = this.group.position;
        const relY = localPos.y - groupPos.y;

        if (this.grabbedIndex === 0) {
            // Moving endpoint A
            this.posA.set(localPos.x - groupPos.x, 0, localPos.z - groupPos.z);
            this.dotA.position.set(this.posA.x, relY, this.posA.z);
        } else if (this.grabbedIndex === 1) {
            // Moving endpoint B
            this.posB.set(localPos.x - groupPos.x, 0, localPos.z - groupPos.z);
            this.dotB.position.set(this.posB.x, relY, this.posB.z);
        } else if (this.grabbedIndex === 2) {
            // Moving marker - constrain to profile
            this._snapMarkerToProfile(localPos);
        }
    }

    /**
     * Constrain marker to nearest point on the profile line.
     * @param {THREE.Vector3} localPos - Target position in model-local space
     */
    _snapMarkerToProfile(localPos) {
        if (this.profilePoints.length < 2) return;

        const groupPos = this.group.position;
        const targetLocal = new THREE.Vector3(
            localPos.x - groupPos.x,
            localPos.y - groupPos.y,
            localPos.z - groupPos.z
        );

        // Find the closest point on the profile
        let closestDist = Infinity;
        let closestT = 0.5;

        for (let i = 0; i < this.profilePoints.length - 1; i++) {
            const p0 = this.profilePoints[i].pos;
            const p1 = this.profilePoints[i + 1].pos;

            // Project target onto line segment p0-p1
            const seg = new THREE.Vector3().subVectors(p1, p0);
            const segLengthSq = seg.lengthSq();

            if (segLengthSq === 0) continue;

            const toTarget = new THREE.Vector3().subVectors(targetLocal, p0);
            const t = Math.max(0, Math.min(1, toTarget.dot(seg) / segLengthSq));

            const closestPoint = new THREE.Vector3().copy(p0).addScaledVector(seg, t);
            const dist = targetLocal.distanceTo(closestPoint);

            if (dist < closestDist) {
                closestDist = dist;
                // Calculate the t value along the entire profile
                const d0 = this.profilePoints[i].distFromA;
                const d1 = this.profilePoints[i + 1].distFromA;
                const interpDist = d0 + (d1 - d0) * t;
                closestT = this.totalDistance > 0 ? interpDist / this.totalDistance : 0.5;
            }
        }

        this.markerT = Math.max(0, Math.min(1, closestT));
    }

    /**
     * End grab.
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

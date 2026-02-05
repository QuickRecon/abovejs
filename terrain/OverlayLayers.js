/**
 * OverlayLayers.js - 3D contour line visualization
 *
 * Creates Three.js contour line objects on terrain surface.
 */

import * as THREE from 'three';
import { disposeThreeObject } from './utils.js';

/**
 * Configuration defaults.
 */
const DEFAULT_CONFIG = {
    // Height offset for contours above terrain surface
    contourHeightOffset: 0.000001,

    // Contour line colors
    contourColor: 0x000000,
    contourMajorWidth: 2,
    contourMinorWidth: 1,

    // Contour simplification tolerance (model units, 0 = no simplification)
    contourSimplifyTolerance: 0.0001
};

/**
 * OverlayLayers manages contour line overlays.
 */
export class OverlayLayers {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Group for contour lines
        this.contourGroup = null;

        // Parent container reference
        this.parentGroup = null;

        // Terrain reference for height lookups
        this.terrainMesh = null;

        // Visibility state
        this.visibility = {
            contours: true
        };

        // Track last Z-exaggeration for scaling updates
        this.lastZExaggeration = null;
    }

    /**
     * Initialize overlay layers.
     * @param {THREE.Group} parentGroup - Parent group for all overlays
     * @param {TerrainMesh} terrainMesh - Terrain for height lookups
     */
    init(parentGroup, terrainMesh) {
        this.parentGroup = parentGroup;
        this.terrainMesh = terrainMesh;

        this.contourGroup = new THREE.Group();
        this.contourGroup.name = 'contours';
        parentGroup.add(this.contourGroup);
    }

    /**
     * Create contour lines from raw line segments (Float32Array of vertex positions).
     * @param {Float32Array} segments - Flat array of vertex positions [x,y,z, x,y,z, ...]
     * @param {number} vertexCount - Number of vertices
     */
    createContoursFromSegments(segments, vertexCount) {
        if (this.terrainMesh) {
            this.lastZExaggeration = this.terrainMesh.getZExaggeration();
        }

        this._clearGroup(this.contourGroup);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));

        const material = new THREE.LineBasicMaterial({
            color: this.config.contourColor,
            depthTest: true
        });

        const lines = new THREE.LineSegments(geometry, material);
        lines.name = 'contours_batched';
        lines.frustumCulled = false;
        this.contourGroup.add(lines);

        console.log(`Contours from segments: ${(vertexCount / 2).toLocaleString()} segments, ${vertexCount.toLocaleString()} vertices`);

        this.contourGroup.visible = this.visibility.contours;
    }

    /**
     * Update contours after Z-exaggeration change.
     * Scales Y coordinates directly instead of regenerating.
     */
    updateForZExaggeration() {
        if (!this.terrainMesh) return;

        const newExaggeration = this.terrainMesh.getZExaggeration();

        if (this.lastZExaggeration === null || this.lastZExaggeration === newExaggeration) {
            this.lastZExaggeration = newExaggeration;
            return;
        }

        const scaleRatio = newExaggeration / this.lastZExaggeration;
        this._scaleGroupY(this.contourGroup, scaleRatio);
        this.lastZExaggeration = newExaggeration;
    }

    /**
     * Scale Y coordinates of all geometries in a group.
     * @param {THREE.Group} group
     * @param {number} scaleRatio
     */
    _scaleGroupY(group, scaleRatio) {
        if (!group) return;

        group.traverse((child) => {
            if (child.geometry && child.geometry.attributes.position) {
                const positions = child.geometry.attributes.position;
                for (let i = 0; i < positions.count; i++) {
                    const y = positions.getY(i);
                    positions.setY(i, y * scaleRatio);
                }
                positions.needsUpdate = true;
                child.geometry.computeBoundingSphere();
            }
        });
    }

    /**
     * Clear all objects from a group.
     * @param {THREE.Group} group
     */
    _clearGroup(group) {
        while (group.children.length > 0) {
            const child = group.children[0];
            disposeThreeObject(child);
            group.remove(child);
        }
    }

    /**
     * Set layer visibility.
     * @param {string} layer - 'contours'
     * @param {boolean} visible
     */
    setVisibility(layer, visible) {
        this.visibility[layer] = visible;

        if (layer === 'contours' && this.contourGroup) {
            this.contourGroup.visible = visible;
        }
    }

    /**
     * Clean up resources.
     */
    dispose() {
        if (this.contourGroup) {
            this._clearGroup(this.contourGroup);
            if (this.parentGroup) this.parentGroup.remove(this.contourGroup);
        }

        this.contourGroup = null;
        this.parentGroup = null;
        this.terrainMesh = null;
    }
}

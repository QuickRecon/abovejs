import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { OverlayLayers } from '../terrain/OverlayLayers.js';

/**
 * Create a mock contour group with known vertex positions.
 */
function createMockContourGroup(positions) {
    const group = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    const material = new THREE.LineBasicMaterial({ color: 0x000000 });
    const lines = new THREE.LineSegments(geometry, material);
    group.add(lines);
    return group;
}

describe('OverlayLayers._scaleGroupY', () => {
    it('Y coordinates scaled by ratio', () => {
        const ol = new OverlayLayers();
        const group = createMockContourGroup([
            1, 2, 3,  // vertex 0
            4, 5, 6   // vertex 1
        ]);

        ol._scaleGroupY(group, 2.0);

        const positions = group.children[0].geometry.attributes.position;
        expect(positions.getY(0)).toBeCloseTo(4, 5);  // 2 * 2.0
        expect(positions.getY(1)).toBeCloseTo(10, 5); // 5 * 2.0
    });

    it('X and Z unchanged', () => {
        const ol = new OverlayLayers();
        const group = createMockContourGroup([
            1, 2, 3,
            4, 5, 6
        ]);

        ol._scaleGroupY(group, 3.0);

        const positions = group.children[0].geometry.attributes.position;
        expect(positions.getX(0)).toBeCloseTo(1, 5);
        expect(positions.getZ(0)).toBeCloseTo(3, 5);
        expect(positions.getX(1)).toBeCloseTo(4, 5);
        expect(positions.getZ(1)).toBeCloseTo(6, 5);
    });

    it('identity when ratio is 1', () => {
        const ol = new OverlayLayers();
        const group = createMockContourGroup([
            1, 2, 3,
            4, 5, 6
        ]);

        ol._scaleGroupY(group, 1.0);

        const positions = group.children[0].geometry.attributes.position;
        expect(positions.getX(0)).toBeCloseTo(1, 5);
        expect(positions.getY(0)).toBeCloseTo(2, 5);
        expect(positions.getZ(0)).toBeCloseTo(3, 5);
    });

    it('sequential scaling composes correctly', () => {
        const ol = new OverlayLayers();
        const group = createMockContourGroup([
            1, 10, 3
        ]);

        ol._scaleGroupY(group, 2.0);
        ol._scaleGroupY(group, 0.5);

        const positions = group.children[0].geometry.attributes.position;
        // 10 * 2.0 * 0.5 = 10
        expect(positions.getY(0)).toBeCloseTo(10, 5);
    });
});

describe('OverlayLayers.updateForZExaggeration', () => {
    it('scales Y when exaggeration changes', () => {
        const ol = new OverlayLayers();
        const parent = new THREE.Group();
        const mockTerrain = {
            getZExaggeration: () => 4,
            modelWidth: 1,
            modelHeight: 1
        };

        ol.init(parent, mockTerrain);
        ol.contourGroup = createMockContourGroup([
            1, 10, 3,
            4, 20, 6
        ]);

        // Set initial exaggeration
        ol.lastZExaggeration = 2;

        // Mock terrain now returns 4
        ol.updateForZExaggeration();

        const positions = ol.contourGroup.children[0].geometry.attributes.position;
        // Scale ratio = 4 / 2 = 2
        expect(positions.getY(0)).toBeCloseTo(20, 5);
        expect(positions.getY(1)).toBeCloseTo(40, 5);
    });

    it('no change when exaggeration is equal', () => {
        const ol = new OverlayLayers();
        const parent = new THREE.Group();
        const mockTerrain = {
            getZExaggeration: () => 4,
            modelWidth: 1,
            modelHeight: 1
        };

        ol.init(parent, mockTerrain);
        ol.contourGroup = createMockContourGroup([
            1, 10, 3
        ]);

        ol.lastZExaggeration = 4;
        ol.updateForZExaggeration();

        const positions = ol.contourGroup.children[0].geometry.attributes.position;
        expect(positions.getY(0)).toBeCloseTo(10, 5);
    });
});

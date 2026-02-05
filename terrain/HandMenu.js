/**
 * HandMenu.js - Circular hand menu for AR tool selection
 *
 * Appears on the back of the user's hand, allowing selection
 * of interactive tools (depth probe, measure tool) via pinch.
 */

import * as THREE from 'three';
import { createTextSprite } from './ToolUtils.js';

/** Menu states */
export const MenuState = {
    HIDDEN: 'hidden',
    VISIBLE: 'visible',
    ACTIVE: 'active',
    SELECTING: 'selecting'
};

/** Tool types available in the menu */
export const ToolType = {
    DEPTH_PROBE: 'depth_probe',
    MEASURE: 'measure'
};

const MENU_RADIUS = 0.045; // meters (disc radius)
const ICON_OFFSET = 0.027; // distance from center to icon
const BACK_OF_HAND_THRESHOLD = -0.3; // dot product threshold
const HYSTERESIS_MS = 200;
const ACTIVATION_DISTANCE = 0.12; // finger must be within this to activate
const SELECT_DISTANCE = 0.035; // finger near icon to select
const HAND_PROXIMITY_DISTANCE = 0.15; // other hand must be within this to show disc

export class HandMenu {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = 'handMenu';
        this.group.visible = false;

        this.state = MenuState.HIDDEN;

        // Which hand is the menu hand (0 or 1), -1 = none
        this.menuHandIndex = -1;
        this.interactingHandIndex = -1;

        // Hysteresis tracking
        this._backOfHandStart = 0;
        this._lastBackOfHand = false;

        // Visual components
        this.disc = null;
        this.icons = []; // [{sprite, toolType, angle}]
        this.highlightArc = null;
        this.deleteIcon = null;

        // Selected tool type (set when pinch happens over an icon)
        this.selectedTool = null;

        // Whether delete zone is active
        this.deleteActive = false;

        // Callbacks
        this.onToolSelected = null; // (toolType, menuWorldPos) => void

        this._createVisuals();
    }

    /**
     * Create menu visual elements.
     */
    _createVisuals() {
        // Semi-transparent dark disc
        const discGeo = new THREE.CircleGeometry(MENU_RADIUS, 32);
        const discMat = new THREE.MeshBasicMaterial({
            color: 0x222222,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.7,
            depthTest: false
        });
        this.disc = new THREE.Mesh(discGeo, discMat);
        this.group.add(this.disc);

        // Tool icons - arranged at opposite sides
        const tools = [
            { type: ToolType.DEPTH_PROBE, label: 'Depth', angle: Math.PI / 2 },
            { type: ToolType.MEASURE, label: 'Measure', angle: -Math.PI / 2 }
        ];

        for (const tool of tools) {
            const sprite = createTextSprite(tool.label, {
                fontSize: 42,
                color: '#ffffff',
                canvasWidth: 256,
                canvasHeight: 64,
                spriteScale: 0.025
            });
            sprite.position.set(
                Math.cos(tool.angle) * ICON_OFFSET,
                Math.sin(tool.angle) * ICON_OFFSET,
                0.001
            );
            sprite.visible = false;
            sprite.material.color.set(0x4fc3f7);
            sprite.renderOrder = 1;
            this.group.add(sprite);
            this.icons.push({ sprite, toolType: tool.type, angle: tool.angle });
        }

        // Highlight arc (simple ring segment - we use a thin ring for simplicity)
        const arcGeo = new THREE.RingGeometry(MENU_RADIUS * 0.75, MENU_RADIUS * 0.95, 16, 1, 0, Math.PI);
        const arcMat = new THREE.MeshBasicMaterial({
            color: 0x4fc3f7,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.4,
            depthTest: false
        });
        this.highlightArc = new THREE.Mesh(arcGeo, arcMat);
        this.highlightArc.renderOrder = 1;
        this.highlightArc.visible = false;
        this.group.add(this.highlightArc);

        // Delete zone icon (red X) at center - only shown during tool return
        this.deleteIcon = createTextSprite('X', {
            fontSize: 56,
            color: '#ff4444',
            canvasWidth: 128,
            canvasHeight: 128,
            spriteScale: 0.02
        });
        this.deleteIcon.position.set(0, 0, 0.002);
        this.deleteIcon.renderOrder = 2;
        this.deleteIcon.visible = false;
        this.group.add(this.deleteIcon);
    }

    /**
     * Update the hand menu each frame.
     * @param {THREE.Object3D} hand0 - First XRHand
     * @param {THREE.Object3D} hand1 - Second XRHand
     * @param {Object[]} handStates - [{isPinching, position}] from HandTracking
     * @param {THREE.Camera} camera
     * @param {boolean} toolGrabActive - Whether a tool is currently being grabbed/returned
     */
    update(hand0, hand1, handStates, camera, toolGrabActive) {
        const hands = [hand0, hand1];

        // Determine which hand's back faces the camera
        const cameraPos = new THREE.Vector3();
        camera.getWorldPosition(cameraPos);

        let bestMenuHand = -1;
        let bestDot = 0;

        for (let i = 0; i < 2; i++) {
            const hand = hands[i];
            if (!hand?.joints) continue;

            const wrist = hand.joints['wrist'];
            if (!wrist) continue;

            // Get palm normal (negative Y axis of the joint = outward from palm)
            const palmNormal = new THREE.Vector3(0, -1, 0);
            palmNormal.applyQuaternion(wrist.quaternion);

            // Vector from wrist to camera
            const wristPos = new THREE.Vector3();
            wrist.getWorldPosition(wristPos);
            const toCamera = cameraPos.clone().sub(wristPos).normalize();

            // If palm normal points away from camera (dot < threshold), back is visible
            const dot = palmNormal.dot(toCamera);
            if (dot < BACK_OF_HAND_THRESHOLD && dot < bestDot) {
                bestDot = dot;
                bestMenuHand = i;
            }
        }

        // Apply hysteresis
        const now = performance.now();
        if (bestMenuHand >= 0) {
            if (!this._lastBackOfHand) {
                this._backOfHandStart = now;
                this._lastBackOfHand = true;
            }

            if (now - this._backOfHandStart < HYSTERESIS_MS) {
                bestMenuHand = this.menuHandIndex; // keep previous
            }
        } else {
            if (this._lastBackOfHand) {
                this._backOfHandStart = now;
                this._lastBackOfHand = false;
            }

            if (now - this._backOfHandStart < HYSTERESIS_MS) {
                bestMenuHand = this.menuHandIndex;
            }
        }

        // Update menu hand
        if (bestMenuHand < 0) {
            this._setState(MenuState.HIDDEN);
            return;
        }

        this.menuHandIndex = bestMenuHand;
        this.interactingHandIndex = bestMenuHand === 0 ? 1 : 0;

        // Position menu on the back of the menu hand
        const menuHand = hands[this.menuHandIndex];
        if (!menuHand?.joints) {
            this._setState(MenuState.HIDDEN);
            return;
        }

        // Use the proximal phalanx (knuckle) for centering on the back of hand,
        // rather than the metacarpal which sits inside the palm near the wrist
        const knuckle = menuHand.joints['middle-finger-phalanx-proximal']
            || menuHand.joints['middle-finger-metacarpal'];
        if (!knuckle) {
            this._setState(MenuState.HIDDEN);
            return;
        }

        // Get back-of-hand normal (palm normal = -Y, so back = +Y)
        const backNormal = new THREE.Vector3(0, 1, 0);
        backNormal.applyQuaternion(knuckle.quaternion);

        const knucklePos = new THREE.Vector3();
        knuckle.getWorldPosition(knucklePos);

        // Offset ~3cm along back-of-hand normal to float above the hand surface
        this.group.position.copy(knucklePos).add(backNormal.multiplyScalar(0.03));

        // Orient menu to face outward from back of hand.
        // The knuckle's +Z points along the finger, but CircleGeometry's
        // normal is +Z. Rotate -90° around local X so the disc normal
        // aligns with the knuckle's +Y (back-of-hand direction), making
        // the disc lie parallel to the palm plane.
        this.group.quaternion.copy(knuckle.quaternion);
        const palmRotation = new THREE.Quaternion()
            .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        this.group.quaternion.multiply(palmRotation);

        // Only show the menu when the interacting hand is close enough
        // that an interaction is imminent
        const interactingHand = hands[this.interactingHandIndex];
        const indexTip = interactingHand?.joints?.['index-finger-tip'];

        if (!indexTip) {
            this._setState(MenuState.HIDDEN);
            return;
        }

        const fingerPos = new THREE.Vector3();
        indexTip.getWorldPosition(fingerPos);

        const distToMenu = fingerPos.distanceTo(this.group.position);

        // Hide entirely if the other hand is too far away
        if (distToMenu > HAND_PROXIMITY_DISTANCE) {
            this._setState(MenuState.HIDDEN);
            return;
        }

        this.group.visible = true;

        // Show delete icon if a tool grab is active
        this.deleteIcon.visible = toolGrabActive;

        if (distToMenu > ACTIVATION_DISTANCE) {
            this._setState(MenuState.VISIBLE);
            this._hideIcons();
            return;
        }

        // Hand is near - show icons (ACTIVE state)
        this._setState(MenuState.ACTIVE);
        this._showIcons();

        // Project finger into menu-local space to check icon proximity
        const localFinger = this.group.worldToLocal(fingerPos.clone());

        // Check which icon is closest
        let closestIcon = null;
        let closestDist = SELECT_DISTANCE;

        for (const icon of this.icons) {
            const iconPos = icon.sprite.position;
            const dist = localFinger.distanceTo(iconPos);
            if (dist < closestDist) {
                closestDist = dist;
                closestIcon = icon;
            }
        }

        if (closestIcon) {
            this._setState(MenuState.SELECTING);

            // Highlight the selected sector
            this.highlightArc.visible = true;
            this.highlightArc.rotation.z = closestIcon.angle - Math.PI / 2;

            // Highlight icon color
            for (const icon of this.icons) {
                const color = icon === closestIcon ? '#ffffff' : '#4fc3f7';
                if (icon.sprite.material.color) {
                    icon.sprite.material.color.set(icon === closestIcon ? 0xffffff : 0x4fc3f7);
                }
            }

            // Check for pinch to select
            const interactingState = handStates[this.interactingHandIndex];
            if (interactingState?.isPinching) {
                this.selectedTool = closestIcon.toolType;
                if (this.onToolSelected) {
                    this.onToolSelected(closestIcon.toolType, this.group.position.clone());
                }
            }
        } else {
            this.highlightArc.visible = false;
            // Reset icon colors
            for (const icon of this.icons) {
                icon.sprite.material.color.set(0x4fc3f7);
            }
        }
    }

    /**
     * Get the menu's world position (for delete zone checks).
     * @returns {THREE.Vector3}
     */
    getWorldPosition() {
        return this.group.position.clone();
    }

    /**
     * Check if a world position is in the delete zone.
     * @param {THREE.Vector3} worldPos
     * @returns {boolean}
     */
    isInDeleteZone(worldPos) {
        return worldPos.distanceTo(this.group.position) < MENU_RADIUS;
    }

    /**
     * Show/hide delete icon.
     * @param {boolean} visible
     */
    showDeleteIcon(visible) {
        if (this.deleteIcon) this.deleteIcon.visible = visible;
    }

    _setState(newState) {
        if (this.state === newState) return;
        this.state = newState;

        if (newState === MenuState.HIDDEN) {
            this.group.visible = false;
            this.selectedTool = null;
        }
    }

    _showIcons() {
        for (const icon of this.icons) {
            icon.sprite.visible = true;
        }
    }

    _hideIcons() {
        for (const icon of this.icons) {
            icon.sprite.visible = false;
        }
        this.highlightArc.visible = false;
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

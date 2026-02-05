/**
 * ToolUtils.js - Shared helpers for AR hand tools
 *
 * Provides billboard text sprites, coordinate space transforms,
 * and a simple throttle wrapper used by DepthProbeTool, MeasureTool,
 * HandMenu, and ToolManager.
 */

import * as THREE from 'three';

/**
 * Create a billboard text sprite using a canvas texture.
 * Follows the same pattern as ARScene._createLoadingIndicator.
 * @param {string} text - Initial text to display
 * @param {Object} [options]
 * @param {number} [options.fontSize=48] - Font size in canvas pixels
 * @param {string} [options.fontFamily='Arial'] - Font family
 * @param {string} [options.color='#ffffff'] - Text fill color
 * @param {string} [options.backgroundColor] - Optional background fill (e.g. 'rgba(0,0,0,0.6)')
 * @param {number} [options.canvasWidth=512] - Canvas width
 * @param {number} [options.canvasHeight=128] - Canvas height
 * @param {number} [options.spriteScale=0.15] - World-space width of the sprite
 * @returns {THREE.Sprite} Sprite with `.userData.canvas` and `.userData.texture` for updates
 */
export function createTextSprite(text, options = {}) {
    const {
        fontSize = 48,
        fontFamily = 'Arial',
        color = '#ffffff',
        backgroundColor,
        canvasWidth = 512,
        canvasHeight = 128,
        spriteScale = 0.15
    } = options;

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false
    });
    const sprite = new THREE.Sprite(material);

    const aspect = canvasWidth / canvasHeight;
    sprite.scale.set(spriteScale, spriteScale / aspect, 1);

    // Store refs for later updates
    sprite.userData.canvas = canvas;
    sprite.userData.texture = texture;
    sprite.userData.fontSize = fontSize;
    sprite.userData.fontFamily = fontFamily;
    sprite.userData.color = color;
    sprite.userData.backgroundColor = backgroundColor;

    // Draw initial text
    updateTextSprite(sprite, text, options);

    return sprite;
}

/**
 * Redraw a text sprite's canvas and flag the texture for upload.
 * @param {THREE.Sprite} sprite - Sprite created by createTextSprite
 * @param {string} text - New text to render
 * @param {Object} [options] - Override any of the creation-time options
 */
export function updateTextSprite(sprite, text, options = {}) {
    const canvas = sprite.userData.canvas;
    if (!canvas) return;

    const fontSize = options.fontSize ?? sprite.userData.fontSize;
    const fontFamily = options.fontFamily ?? sprite.userData.fontFamily;
    const color = options.color ?? sprite.userData.color;
    const backgroundColor = options.backgroundColor ?? sprite.userData.backgroundColor;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (backgroundColor) {
        ctx.fillStyle = backgroundColor;
        // Rounded rect background
        const pad = 12;
        const w = canvas.width - pad * 2;
        const h = canvas.height - pad * 2;
        const r = 16;
        ctx.beginPath();
        ctx.moveTo(pad + r, pad);
        ctx.lineTo(pad + w - r, pad);
        ctx.quadraticCurveTo(pad + w, pad, pad + w, pad + r);
        ctx.lineTo(pad + w, pad + h - r);
        ctx.quadraticCurveTo(pad + w, pad + h, pad + w - r, pad + h);
        ctx.lineTo(pad + r, pad + h);
        ctx.quadraticCurveTo(pad, pad + h, pad, pad + h - r);
        ctx.lineTo(pad, pad + r);
        ctx.quadraticCurveTo(pad, pad, pad + r, pad);
        ctx.closePath();
        ctx.fill();
    }

    ctx.fillStyle = color;
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    sprite.userData.texture.needsUpdate = true;
}

/**
 * Convert a world-space position to model-local coordinates.
 * Follows the inverse of the modelContainer transform chain
 * (same pattern as HandTracking._captureGestureStartData lines 304-308).
 * @param {THREE.Vector3} worldPos - Position in XR world space
 * @param {THREE.Group} modelContainer - The scene's model container
 * @returns {THREE.Vector3} Position in model-local space
 */
export function worldToLocal(worldPos, modelContainer) {
    const local = worldPos.clone().sub(modelContainer.position);
    local.applyAxisAngle(new THREE.Vector3(0, 1, 0), -modelContainer.rotation.y);
    local.divideScalar(modelContainer.scale.x);
    return local;
}

/**
 * Convert a model-local position to world-space coordinates.
 * @param {THREE.Vector3} localPos - Position in model-local space
 * @param {THREE.Group} modelContainer - The scene's model container
 * @returns {THREE.Vector3} Position in XR world space
 */
export function localToWorld(localPos, modelContainer) {
    const world = localPos.clone();
    world.multiplyScalar(modelContainer.scale.x);
    world.applyAxisAngle(new THREE.Vector3(0, 1, 0), modelContainer.rotation.y);
    world.add(modelContainer.position);
    return world;
}

/**
 * Compute a uniform scale factor to keep an element's world-space size
 * clamped within [minWorld, maxWorld].
 * @param {number} geoSize - Size in model-local geometry units (e.g. sphere radius)
 * @param {number} containerScale - modelContainer.scale.x
 * @param {number} minWorld - Minimum allowed world-space size
 * @param {number} maxWorld - Maximum allowed world-space size
 * @returns {number} Scale factor to apply to the mesh
 */
export function clampedElementScale(geoSize, containerScale, minWorld, maxWorld) {
    const worldSize = geoSize * containerScale;
    if (worldSize < minWorld) return minWorld / worldSize;
    if (worldSize > maxWorld) return maxWorld / worldSize;
    return 1;
}

/**
 * Create a simple throttle wrapper.
 * @param {Function} fn - Function to throttle
 * @param {number} intervalMs - Minimum interval between calls
 * @returns {Function} Throttled function
 */
export function throttle(fn, intervalMs) {
    let lastCall = 0;
    return function (...args) {
        const now = performance.now();
        if (now - lastCall >= intervalMs) {
            lastCall = now;
            return fn.apply(this, args);
        }
    };
}

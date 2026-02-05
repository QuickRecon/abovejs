/**
 * AR utility functions
 */

/**
 * Dispose of a Three.js object and its resources.
 * Handles geometry, materials, textures, and arrays of materials.
 * @param {THREE.Object3D} object - The Three.js object to dispose
 */
export function disposeThreeObject(object) {
    if (!object) return;

    if (object.geometry) {
        object.geometry.dispose();
    }

    if (object.material) {
        if (Array.isArray(object.material)) {
            object.material.forEach(disposeMaterial);
        } else {
            disposeMaterial(object.material);
        }
    }
}

/**
 * Dispose of a Three.js material and its textures.
 * @param {THREE.Material} material - The material to dispose
 */
function disposeMaterial(material) {
    if (!material) return;

    // Dispose common texture types
    if (material.map) material.map.dispose();
    if (material.normalMap) material.normalMap.dispose();
    if (material.roughnessMap) material.roughnessMap.dispose();
    if (material.metalnessMap) material.metalnessMap.dispose();
    if (material.aoMap) material.aoMap.dispose();
    if (material.emissiveMap) material.emissiveMap.dispose();
    if (material.lightMap) material.lightMap.dispose();
    if (material.bumpMap) material.bumpMap.dispose();
    if (material.displacementMap) material.displacementMap.dispose();
    if (material.envMap) material.envMap.dispose();
    if (material.alphaMap) material.alphaMap.dispose();

    material.dispose();
}

/**
 * Recursively dispose all objects in a Three.js hierarchy.
 * @param {THREE.Object3D} object - The root object to traverse and dispose
 */
export function disposeHierarchy(object) {
    if (!object) return;

    object.traverse((child) => {
        disposeThreeObject(child);
    });
}

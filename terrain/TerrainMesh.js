/**
 * TerrainMesh.js - GPU-accelerated 3D terrain generation from COG elevation data
 *
 * Creates a 3D mesh from elevation data with:
 * - GPU-based vertex displacement via custom shaders
 * - GPU-generated normal maps
 * - Vertex coloring using Turbo colormap (no texture needed)
 * - Above-reference triangle filtering to save GPU bandwidth
 * - Real-time Z-exaggeration via uniforms (no mesh regeneration)
 * - NoData handling via fragment shader discard
 */

import * as THREE from 'three';
import { TURBO_COLORMAP, processInChunks } from '../utils.js';

// Marching squares edge lookup table (16 cases).
// Each case maps to pairs of edges where the contour crosses.
// Edges: 0=top, 1=right, 2=bottom, 3=left
// Cases 5 and 10 are saddle cases resolved at runtime using center average.
const MS_EDGE_TABLE = [
    [],           // 0:  no edges
    [[3, 2]],     // 1:  bottom-left
    [[2, 1]],     // 2:  bottom-right
    [[3, 1]],     // 3:  bottom
    [[0, 1]],     // 4:  top-right
    null,         // 5:  saddle — resolved at runtime
    [[0, 2]],     // 6:  right
    [[3, 0]],     // 7:  all except top-left
    [[0, 3]],     // 8:  top-left
    [[0, 2]],     // 9:  left
    null,         // 10: saddle — resolved at runtime
    [[0, 1]],     // 11: all except top-right
    [[3, 1]],     // 12: top
    [[2, 1]],     // 13: all except bottom-right
    [[3, 2]],     // 14: all except bottom-left
    []            // 15: all corners above — no edges
];

// Inline shaders as template strings (no bundler required)

const terrainVertexShader = /* glsl */`
    uniform sampler2D elevationMap;
    uniform float waterLevel;
    uniform float heightScale;  // Pre-computed: zExaggeration / realWorldScale
    uniform vec2 elevationSize;

    attribute vec3 color;

    varying vec2 vUv;
    varying float vIsNoData;
    varying vec3 vNormal;
    varying vec3 vColor;

    const float NO_DATA_THRESHOLD = 1e5;

    void main() {
        vUv = uv;
        vColor = color;

        // Flip V to match raster data orientation (row 0 = north = mesh back)
        vec2 elevUv = vec2(uv.x, 1.0 - uv.y);

        // Sample elevation at this vertex's UV coordinate
        float elevation = texture2D(elevationMap, elevUv).r;

        // Check for NoData
        vIsNoData = (elevation >= NO_DATA_THRESHOLD) ? 1.0 : 0.0;

        // Calculate Y displacement
        float height = 0.0;
        if (vIsNoData < 0.5) {
            height = (elevation - waterLevel) * heightScale;
        }

        // Displace vertex position (plane is rotated to XZ, so Y is up)
        vec3 displacedPosition = vec3(position.x, height, position.z);

        // Transform to world space for lighting
        vec4 worldPosition = modelMatrix * vec4(displacedPosition, 1.0);

        // Transform normal
        vNormal = normalize(normalMatrix * normal);

        // Final position
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
`;

const terrainFragmentShader = /* glsl */`
    uniform sampler2D normalMap;
    uniform float normalScale;
    uniform vec3 ambientColor;
    uniform vec3 lightColor;
    uniform vec3 lightDirection;
    uniform float diffuseStrength;

    varying vec2 vUv;
    varying float vIsNoData;
    varying vec3 vNormal;
    varying vec3 vColor;

    void main() {
        // Discard NoData pixels
        if (vIsNoData > 0.5) {
            discard;
        }

        // Use vertex color
        vec3 baseColor = vColor;

        // Sample and decode normal map (z stored directly, no sqrt needed)
        vec3 mappedNormal = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;

        // Blend geometry normal with normal map
        vec3 N = normalize(vNormal + vec3(mappedNormal.x * normalScale, 0.0, mappedNormal.y * normalScale));

        // Basic diffuse lighting (lightDirection pre-normalized on CPU)
        float NdotL = max(dot(N, lightDirection), 0.0);

        // Simple lighting model
        vec3 ambient = ambientColor * baseColor;
        vec3 diffuse = lightColor * baseColor * NdotL;

        // Combine lighting (diffuseStrength pre-computed on CPU)
        vec3 finalColor = ambient + diffuse * diffuseStrength;

        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

// CPU fallback shaders (for devices without vertex texture fetch support)

const cpuFallbackVertexShader = /* glsl */`
    attribute vec3 color;

    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vColor;

    void main() {
        vUv = uv;
        vColor = color;

        // Transform to world space for lighting
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);

        // Use geometry normals (computed on CPU after displacement)
        vNormal = normalize(normalMatrix * normal);

        // Final position
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
`;

const cpuFallbackFragmentShader = /* glsl */`
    uniform sampler2D normalMap;
    uniform float normalScale;
    uniform vec3 ambientColor;
    uniform vec3 lightColor;
    uniform vec3 lightDirection;
    uniform float diffuseStrength;

    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vColor;

    void main() {
        // Use vertex color
        vec3 baseColor = vColor;

        // Sample and decode normal map (z stored directly, no sqrt needed)
        vec3 mappedNormal = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;

        // Blend geometry normal with normal map
        vec3 N = normalize(vNormal + vec3(mappedNormal.x * normalScale, 0.0, mappedNormal.y * normalScale));

        // Basic diffuse lighting (lightDirection pre-normalized on CPU)
        float NdotL = max(dot(N, lightDirection), 0.0);

        // Simple lighting model
        vec3 ambient = ambientColor * baseColor;
        vec3 diffuse = lightColor * baseColor * NdotL;

        // Combine lighting (diffuseStrength pre-computed on CPU)
        vec3 finalColor = ambient + diffuse * diffuseStrength;

        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

/**
 * Default configuration for terrain mesh.
 */
const DEFAULT_CONFIG = {
    // Target polygon count (triangles) in valid data areas
    targetPolygons: 3_000_000,

    // Initial model size in meters (for the longer dimension)
    modelSize: 1,

    // Z-exaggeration range
    minZExaggeration: 1,
    maxZExaggeration: 10,
    defaultZExaggeration: 4,

    // Normal map strength
    normalMapStrength: 5,

    // Lighting defaults
    ambientColor: new THREE.Color(0.3, 0.3, 0.3),
    lightColor: new THREE.Color(1.0, 1.0, 1.0),
    lightDirection: new THREE.Vector3(0.5, 1.0, 0.5).normalize()
};

/**
 * TerrainMesh creates and manages the 3D terrain geometry with GPU acceleration.
 */
export class TerrainMesh {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Three.js objects
        this.mesh = null;
        this.geometry = null;
        this.material = null;

        // Elevation data
        this.elevationData = null;
        this.elevationWidth = 0;
        this.elevationHeight = 0;
        this.geoBounds = null; // [minX, minY, maxX, maxY] in projected CRS

        // GPU textures
        this.elevationTexture = null;
        this.normalMap = null;

        // Original geometry indices (for filtering)
        this.originalIndices = null;

        // Computed model dimensions (may not be square)
        this.modelWidth = this.config.modelSize;
        this.modelHeight = this.config.modelSize;

        // State
        this.zExaggeration = this.config.defaultZExaggeration;

        // Generic elevation configuration (replaces Wellington water level system)
        this.referenceElevation = 157; // Default, will be set by analyzeElevation
        this.depthRange = [0, 31];     // Default, will be set by analyzeElevation
        this.noDataValue = null;       // Read from COG metadata

        // Renderer reference for GPU capability detection
        this.renderer = null;

        // Real-world scale factor (scale needed to make model 1:1 with reality)
        this.realWorldScale = 1;
        this.realWorldWidth = 0;  // meters
        this.realWorldHeight = 0; // meters

        // Grid dimensions
        this.gridWidth = 0;
        this.gridHeight = 0;

        // GPU capability flag
        this.useGPUDisplacement = true;
        this.vertexTextureUnitsChecked = false;

        // GPU texture size limit
        this.maxTextureSize = 16384;
    }

    /**
     * Initialize with elevation configuration.
     * @param {number} referenceElevation - Reference elevation (e.g. max elevation or water level)
     * @param {number[]} depthRange - [minDepth, maxDepth] range for coloring
     * @param {number|null} noDataValue - NoData value from COG metadata
     */
    setElevationConfig(referenceElevation, depthRange, noDataValue) {
        this.referenceElevation = referenceElevation;
        this.depthRange = depthRange;
        this.noDataValue = noDataValue;
    }

    /**
     * Update reference elevation and recolor/refilter the terrain.
     * @param {number} referenceElevation - New reference elevation
     */
    async updateReferenceElevation(referenceElevation) {
        this.referenceElevation = referenceElevation;

        if (!this.geometry || !this.elevationData) return;

        // Update GPU shader uniform
        if (this.useGPUDisplacement && this.material?.uniforms?.waterLevel) {
            this.material.uniforms.waterLevel.value = referenceElevation;
        }

        // Recompute vertex colors and filter triangles
        await Promise.all([
            this._computeVertexColorsAsync(),
            this._filterAboveWaterTrianglesAsync()
        ]);

        // For CPU fallback, also update vertex positions
        if (!this.useGPUDisplacement) {
            this._updateVerticesCPU();
        }
    }

    /**
     * Set renderer for GPU operations.
     * @param {THREE.WebGLRenderer} renderer
     */
    setRenderer(renderer) {
        this.renderer = renderer;
        this._checkVertexTextureSupport();
    }

    /**
     * Check GPU capabilities including vertex texture fetch and max texture size.
     */
    _checkVertexTextureSupport() {
        if (!this.renderer || this.vertexTextureUnitsChecked) return;

        this.vertexTextureUnitsChecked = true;

        const gl = this.renderer.getContext();
        const maxVertexTextureUnits = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
        this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

        console.log(`GPU vertex texture units: ${maxVertexTextureUnits}`);
        console.log(`GPU max texture size: ${this.maxTextureSize}`);

        if (maxVertexTextureUnits < 1) {
            console.warn('GPU does not support vertex texture fetch - using CPU vertex displacement');
            this.useGPUDisplacement = false;
        } else {
            console.log('GPU vertex displacement enabled');
            this.useGPUDisplacement = true;
        }
    }

    /**
     * Downsample elevation data if it exceeds GPU texture size limits.
     */
    _constrainElevationToGPULimits() {
        if (!this.elevationData) return;

        const srcWidth = this.elevationWidth;
        const srcHeight = this.elevationHeight;

        if (srcWidth <= this.maxTextureSize && srcHeight <= this.maxTextureSize) {
            return;
        }

        const aspect = srcWidth / srcHeight;
        let newWidth, newHeight;

        if (srcWidth > srcHeight) {
            newWidth = Math.min(srcWidth, this.maxTextureSize);
            newHeight = Math.round(newWidth / aspect);
            if (newHeight > this.maxTextureSize) {
                newHeight = this.maxTextureSize;
                newWidth = Math.round(newHeight * aspect);
            }
        } else {
            newHeight = Math.min(srcHeight, this.maxTextureSize);
            newWidth = Math.round(newHeight * aspect);
            if (newWidth > this.maxTextureSize) {
                newWidth = this.maxTextureSize;
                newHeight = Math.round(newWidth / aspect);
            }
        }

        console.log(`Downsampling elevation data from ${srcWidth}x${srcHeight} to ${newWidth}x${newHeight} (GPU max: ${this.maxTextureSize})`);

        const newData = new Float32Array(newWidth * newHeight);
        const srcData = this.elevationData;

        for (let y = 0; y < newHeight; y++) {
            for (let x = 0; x < newWidth; x++) {
                const srcX = (x / (newWidth - 1)) * (srcWidth - 1);
                const srcY = (y / (newHeight - 1)) * (srcHeight - 1);

                const x0 = Math.floor(srcX);
                const y0 = Math.floor(srcY);
                const x1 = Math.min(x0 + 1, srcWidth - 1);
                const y1 = Math.min(y0 + 1, srcHeight - 1);

                const fx = srcX - x0;
                const fy = srcY - y0;

                const v00 = srcData[y0 * srcWidth + x0];
                const v10 = srcData[y0 * srcWidth + x1];
                const v01 = srcData[y1 * srcWidth + x0];
                const v11 = srcData[y1 * srcWidth + x1];

                const isNoData00 = this._isNoData(v00);
                const isNoData10 = this._isNoData(v10);
                const isNoData01 = this._isNoData(v01);
                const isNoData11 = this._isNoData(v11);

                if (isNoData00 || isNoData10 || isNoData01 || isNoData11) {
                    // Preserve NoData if any neighbor is NoData to avoid
                    // filling small holes and creating normal map artifacts
                    newData[y * newWidth + x] = 1e38;
                } else {
                    const vA = v00 * (1 - fx) + v10 * fx;
                    const vB = v01 * (1 - fx) + v11 * fx;
                    newData[y * newWidth + x] = vA * (1 - fy) + vB * fy;
                }
            }
        }

        this.elevationData = newData;
        this.elevationWidth = newWidth;
        this.elevationHeight = newHeight;

        console.log(`Elevation data downsampled successfully`);
    }

    /**
     * Check if a value is NoData.
     * @param {number} value
     * @returns {boolean}
     */
    _isNoData(value) {
        if (!Number.isFinite(value)) return true;
        if (value >= 1e5) return true;
        if (this.noDataValue !== null && value === this.noDataValue) return true;
        return false;
    }

    /**
     * Create the terrain mesh from elevation data.
     * @param {Object} options
     * @param {Float32Array} options.elevation - Elevation data array
     * @param {number} options.width - Data width
     * @param {number} options.height - Data height
     * @param {number[]} options.geoBounds - [minX, minY, maxX, maxY] in projected CRS
     * @param {Promise} [options.fullResElevationPromise] - Promise for full-res data for normal map
     * @param {THREE.Group} parentGroup - Parent group to add mesh to
     * @param {Function} [onProgress] - Progress callback
     */
    async createFromData(options, parentGroup, onProgress) {
        const { elevation, width, height, geoBounds, fullResElevationPromise } = options;

        if (!this.renderer) {
            console.warn('TerrainMesh: renderer not set before createFromData(). ' +
                'Call setRenderer() first for proper GPU capability detection.');
        }

        this.elevationData = elevation;
        this.elevationWidth = width;
        this.elevationHeight = height;
        this.geoBounds = geoBounds;

        // Calculate model dimensions preserving aspect ratio
        const [minX, minY, maxX, maxY] = geoBounds;
        const geoWidth = maxX - minX;
        const geoHeight = maxY - minY;
        const aspectRatio = geoWidth / geoHeight;

        this.realWorldWidth = geoWidth;
        this.realWorldHeight = geoHeight;

        if (aspectRatio >= 1) {
            this.modelWidth = this.config.modelSize;
            this.modelHeight = this.config.modelSize / aspectRatio;
        } else {
            this.modelWidth = this.config.modelSize * aspectRatio;
            this.modelHeight = this.config.modelSize;
        }

        this.realWorldScale = this.realWorldWidth / this.modelWidth;
        console.log(`Real-world size: ${this.realWorldWidth.toFixed(0)}m x ${this.realWorldHeight.toFixed(0)}m`);
        console.log(`Model size: ${this.modelWidth.toFixed(3)}m x ${this.modelHeight.toFixed(3)}m`);
        console.log(`Scale for 1:1: ${this.realWorldScale.toFixed(1)}x`);

        if (onProgress) onProgress('CREATE_TERRAIN', null);

        this._constrainElevationToGPULimits();
        this._createElevationTexture();
        this._createGeometry();

        if (onProgress) onProgress('COMPUTE_COLORS', null);
        await Promise.all([
            this._computeVertexColorsAsync(onProgress ? (p) => onProgress('COMPUTE_COLORS', p) : null),
            this._filterAboveWaterTrianglesAsync(onProgress ? (p) => onProgress('FILTER_GEOMETRY', p) : null)
        ]);

        if (onProgress) onProgress('GENERATE_NORMALS', null);
        if (fullResElevationPromise) {
            try {
                const fullRes = await fullResElevationPromise;
                console.log(`Using full-res elevation for normal map: ${fullRes.width}x${fullRes.height}`);
                const savedData = this.elevationData;
                const savedWidth = this.elevationWidth;
                const savedHeight = this.elevationHeight;
                this.elevationData = fullRes.elevation;
                this.elevationWidth = fullRes.width;
                this.elevationHeight = fullRes.height;

                await this._generateNormalMapCPUAsync(onProgress ? (p) => onProgress('GENERATE_NORMALS', p) : null);

                this.elevationData = savedData;
                this.elevationWidth = savedWidth;
                this.elevationHeight = savedHeight;
            } catch (e) {
                console.warn('Full-res elevation failed, using low-res for normal map:', e);
                await this._generateNormalMapCPUAsync(onProgress ? (p) => onProgress('GENERATE_NORMALS', p) : null);
            }
        } else {
            await this._generateNormalMapCPUAsync(onProgress ? (p) => onProgress('GENERATE_NORMALS', p) : null);
        }

        this._createMaterial();

        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.name = 'terrainMesh';
        this.mesh.frustumCulled = false;
        this.mesh.position.set(0, 0, 0);

        if (parentGroup) {
            parentGroup.add(this.mesh);
        }

        return this.mesh;
    }

    /**
     * Create a DataTexture from elevation data for GPU access.
     */
    _createElevationTexture() {
        this.elevationTexture = new THREE.DataTexture(
            this.elevationData,
            this.elevationWidth,
            this.elevationHeight,
            THREE.RedFormat,
            THREE.FloatType
        );
        this.elevationTexture.wrapS = THREE.ClampToEdgeWrapping;
        this.elevationTexture.wrapT = THREE.ClampToEdgeWrapping;
        // NearestFilter prevents GPU bilinear interpolation from blending
        // valid elevation values with NoData (1e38), which would produce
        // garbage intermediate heights at NoData boundaries.
        this.elevationTexture.minFilter = THREE.NearestFilter;
        this.elevationTexture.magFilter = THREE.NearestFilter;
        this.elevationTexture.needsUpdate = true;

        console.log(`Created elevation texture: ${this.elevationWidth}x${this.elevationHeight}`);
    }

    /**
     * Create the terrain geometry.
     */
    _createGeometry() {
        const validFraction = this._analyzeValidDataFraction();
        const { gridWidth, gridHeight } = this._calculateGridDimensions(validFraction);

        this.gridWidth = gridWidth;
        this.gridHeight = gridHeight;

        const totalPolys = 2 * (gridWidth - 1) * (gridHeight - 1);
        const estimatedValidPolys = Math.round(totalPolys * validFraction);
        console.log(`Creating terrain geometry: ${gridWidth}x${gridHeight} vertices`);
        console.log(`  Valid data fraction: ${(validFraction * 100).toFixed(1)}%`);
        console.log(`  Total polygons: ${totalPolys.toLocaleString()}, estimated valid: ${estimatedValidPolys.toLocaleString()}`);
        console.log(`  Displacement mode: ${this.useGPUDisplacement ? 'GPU (vertex shader)' : 'CPU (fallback)'}`);

        this.geometry = new THREE.PlaneGeometry(
            this.modelWidth,
            this.modelHeight,
            gridWidth - 1,
            gridHeight - 1
        );

        this.geometry.rotateX(-Math.PI / 2);

        if (!this.useGPUDisplacement) {
            this._updateVerticesCPU();
        }
    }

    /**
     * Analyze elevation data to determine fraction of valid (non-NoData) pixels.
     * @returns {number}
     */
    _analyzeValidDataFraction() {
        if (!this.elevationData) return 1;

        let validCount = 0;
        const total = this.elevationData.length;

        for (let i = 0; i < total; i++) {
            if (!this._isNoData(this.elevationData[i])) {
                validCount++;
            }
        }

        return validCount / total;
    }

    /**
     * Calculate grid dimensions to achieve target polygon count.
     * @param {number} validFraction
     * @returns {{gridWidth: number, gridHeight: number}}
     */
    _calculateGridDimensions(validFraction) {
        const targetPolys = this.config.targetPolygons;
        const aspectRatio = this.elevationWidth / this.elevationHeight;

        const targetQuads = targetPolys / (2 * validFraction);
        const h = Math.sqrt(targetQuads / aspectRatio);
        const w = h * aspectRatio;

        let gridWidth = Math.round(w) + 1;
        let gridHeight = Math.round(h) + 1;

        gridWidth = Math.min(gridWidth, this.elevationWidth);
        gridHeight = Math.min(gridHeight, this.elevationHeight);

        gridWidth = Math.max(gridWidth, 2);
        gridHeight = Math.max(gridHeight, 2);

        return { gridWidth, gridHeight };
    }

    /**
     * Update vertex positions on CPU (fallback).
     */
    _updateVerticesCPU() {
        if (!this.geometry || !this.elevationData) return;

        const positions = this.geometry.attributes.position;
        const uvs = this.geometry.attributes.uv;

        if (!positions || !uvs) return;

        const heightScale = this.getHeightScale();
        let validCount = 0;
        let noDataCount = 0;

        for (let i = 0; i < positions.count; i++) {
            const u = uvs.getX(i);
            const v = uvs.getY(i);
            const elevation = this._sampleElevation(u, v);

            if (!Number.isFinite(elevation)) {
                positions.setY(i, 0);
                noDataCount++;
                continue;
            }

            validCount++;
            const height = (elevation - this.referenceElevation) * heightScale;
            positions.setY(i, height);
        }

        positions.needsUpdate = true;
        this.geometry.computeVertexNormals();
        this._computeVertexColors();

        console.log(`CPU displacement complete: ${validCount} valid, ${noDataCount} nodata vertices`);
    }

    /**
     * Create the shader material.
     */
    _createMaterial() {
        if (this.renderer && !this.vertexTextureUnitsChecked) {
            this._checkVertexTextureSupport();

            if (!this.useGPUDisplacement && this.geometry) {
                console.log('Late GPU check: applying CPU vertex displacement');
                this._updateVerticesCPU();
            }
        }

        if (this.useGPUDisplacement) {
            this.material = new THREE.ShaderMaterial({
                uniforms: {
                    elevationMap: { value: this.elevationTexture },
                    waterLevel: { value: this.referenceElevation },
                    heightScale: { value: this.zExaggeration / this.realWorldScale },
                    elevationSize: { value: new THREE.Vector2(this.elevationWidth, this.elevationHeight) },
                    normalMap: { value: this.normalMap },
                    normalScale: { value: 2.0 },
                    ambientColor: { value: this.config.ambientColor },
                    lightColor: { value: this.config.lightColor },
                    lightDirection: { value: this.config.lightDirection },
                    diffuseStrength: { value: 0.6 }
                },
                vertexShader: terrainVertexShader,
                fragmentShader: terrainFragmentShader,
                side: THREE.FrontSide
            });
        } else {
            this.material = new THREE.ShaderMaterial({
                uniforms: {
                    normalMap: { value: this.normalMap },
                    normalScale: { value: 2.0 },
                    ambientColor: { value: this.config.ambientColor },
                    lightColor: { value: this.config.lightColor },
                    lightDirection: { value: this.config.lightDirection },
                    diffuseStrength: { value: 0.6 }
                },
                vertexShader: cpuFallbackVertexShader,
                fragmentShader: cpuFallbackFragmentShader,
                side: THREE.FrontSide
            });
            console.log('Using CPU fallback material (no vertex texture fetch)');
        }
    }

    /**
     * Get RGB color for a depth value using Turbo colormap.
     * @param {number} depth
     * @param {number} minDepth
     * @param {number} maxDepth
     * @returns {number[]} [r, g, b] in 0-1 range
     */
    _getColorForDepth(depth, minDepth, maxDepth) {
        const normalized = (depth - minDepth) / (maxDepth - minDepth);
        const clamped = Math.max(0, Math.min(1, normalized));
        const inverted = 1 - clamped;

        const index = inverted * (TURBO_COLORMAP.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const frac = index - lower;

        const cL = TURBO_COLORMAP[lower];
        const cU = TURBO_COLORMAP[upper];

        return [
            cL[0] + (cU[0] - cL[0]) * frac,
            cL[1] + (cU[1] - cL[1]) * frac,
            cL[2] + (cU[2] - cL[2]) * frac
        ];
    }

    /**
     * Compute vertex colors synchronously.
     */
    _computeVertexColors() {
        if (!this.geometry || !this.elevationData) return;

        const uvs = this.geometry.attributes.uv;
        if (!uvs) return;

        const vertexCount = uvs.count;
        const colors = new Float32Array(vertexCount * 3);

        const [minDepth, maxDepth] = this.depthRange;

        for (let i = 0; i < vertexCount; i++) {
            const u = uvs.getX(i);
            const v = uvs.getY(i);
            const elevation = this._sampleElevation(u, 1.0 - v);
            const idx = i * 3;

            if (!Number.isFinite(elevation)) {
                colors[idx] = 0.5;
                colors[idx + 1] = 0.5;
                colors[idx + 2] = 0.5;
                continue;
            }

            if (elevation >= this.referenceElevation) {
                colors[idx] = 0.5;
                colors[idx + 1] = 0.5;
                colors[idx + 2] = 0.5;
                continue;
            }

            const depth = this.referenceElevation - elevation;
            const [r, g, b] = this._getColorForDepth(depth, minDepth, maxDepth);

            colors[idx] = r;
            colors[idx + 1] = g;
            colors[idx + 2] = b;
        }

        this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    /**
     * Async version of _computeVertexColors with chunked processing.
     * @param {Function} [onProgress]
     */
    async _computeVertexColorsAsync(onProgress) {
        if (!this.geometry || !this.elevationData) return;

        const uvs = this.geometry.attributes.uv;
        if (!uvs) return;

        const vertexCount = uvs.count;
        const colors = new Float32Array(vertexCount * 3);

        const [minDepth, maxDepth] = this.depthRange;

        let validCount = 0;
        let aboveCount = 0;

        const chunkSize = 10000;
        await processInChunks(vertexCount, chunkSize, (i) => {
            const u = uvs.getX(i);
            const v = uvs.getY(i);
            const elevation = this._sampleElevation(u, 1.0 - v);
            const idx = i * 3;

            if (!Number.isFinite(elevation)) {
                colors[idx] = 0.5;
                colors[idx + 1] = 0.5;
                colors[idx + 2] = 0.5;
                return;
            }

            if (elevation >= this.referenceElevation) {
                colors[idx] = 0.5;
                colors[idx + 1] = 0.5;
                colors[idx + 2] = 0.5;
                aboveCount++;
                return;
            }

            validCount++;
            const depth = this.referenceElevation - elevation;
            const [r, g, b] = this._getColorForDepth(depth, minDepth, maxDepth);

            colors[idx] = r;
            colors[idx + 1] = g;
            colors[idx + 2] = b;
        }, (completed, total) => {
            if (onProgress) onProgress(completed / total);
        });

        this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        console.log(`Vertex colors computed: ${validCount} below reference, ${aboveCount} above reference`);
    }

    /**
     * Filter out triangles where all vertices are above reference elevation (async).
     * @param {Function} [onProgress]
     */
    async _filterAboveWaterTrianglesAsync(onProgress) {
        if (!this.geometry || !this.elevationData) return;

        const uvs = this.geometry.attributes.uv;
        const index = this.geometry.index;

        if (!uvs || !index) return;

        if (!this.originalIndices) {
            this.originalIndices = new Uint32Array(index.array);
        }

        const vertexCount = uvs.count;
        const indices = this.originalIndices;
        const triangleCount = indices.length / 3;

        const isBelowRef = new Uint8Array(vertexCount);
        const isNoData = new Uint8Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
            const u = uvs.getX(i);
            const v = 1.0 - uvs.getY(i);

            if (this._hasNearbyNoData(u, v)) {
                isNoData[i] = 1;
            } else {
                const elevation = this._sampleElevation(u, v);
                if (!Number.isFinite(elevation)) {
                    isNoData[i] = 1;
                } else if (elevation < this.referenceElevation) {
                    isBelowRef[i] = 1;
                }
            }
        }

        const newIndices = [];
        let filteredCount = 0;

        const chunkSize = 5000;
        await processInChunks(triangleCount, chunkSize, (t) => {
            const i0 = indices[t * 3];
            const i1 = indices[t * 3 + 1];
            const i2 = indices[t * 3 + 2];

            // Exclude triangles containing any NoData vertex
            if (isNoData[i0] || isNoData[i1] || isNoData[i2]) {
                filteredCount++;
            } else if (isBelowRef[i0] || isBelowRef[i1] || isBelowRef[i2]) {
                newIndices.push(i0, i1, i2);
            } else {
                filteredCount++;
            }
        }, (completed, total) => {
            if (onProgress) onProgress(completed / total);
        });

        this.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(newIndices), 1));

        const keptTriangles = newIndices.length / 3;
        const reduction = ((filteredCount / triangleCount) * 100).toFixed(1);
        console.log(`Triangle filtering: ${keptTriangles.toLocaleString()} kept, ${filteredCount.toLocaleString()} filtered (${reduction}% reduction)`);
    }

    /**
     * Generate normal map on CPU with chunked async processing.
     * @param {Function} [onProgress]
     */
    async _generateNormalMapCPUAsync(onProgress) {
        if (!this.elevationData) return;

        const width = this.elevationWidth;
        const height = this.elevationHeight;

        console.log(`Generating normal map on CPU (async): ${width}x${height}`);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;

        const cellSizeX = this.realWorldWidth / width;
        const cellSizeY = this.realWorldHeight / height;
        const strength = this.config.normalMapStrength;

        const chunkSize = 50;
        await processInChunks(height, chunkSize, (y) => {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const center = this._getElevationAt(x, y);

                if (!Number.isFinite(center)) {
                    data[idx + 0] = 128;
                    data[idx + 1] = 128;
                    data[idx + 2] = 255;
                    data[idx + 3] = 0;
                    continue;
                }

                let eL = this._getElevationAt(Math.max(0, x - 1), y);
                let eR = this._getElevationAt(Math.min(width - 1, x + 1), y);
                let eT = this._getElevationAt(x, Math.max(0, y - 1));
                let eB = this._getElevationAt(x, Math.min(height - 1, y + 1));

                if (!Number.isFinite(eL)) eL = center;
                if (!Number.isFinite(eR)) eR = center;
                if (!Number.isFinite(eT)) eT = center;
                if (!Number.isFinite(eB)) eB = center;

                const dzdx = (eR - eL) / (2 * cellSizeX) * strength;
                const dzdy = (eB - eT) / (2 * cellSizeY) * strength;

                const nx = -dzdx;
                const ny = -dzdy;
                const nz = 1;

                const len = Math.hypot(nx, ny, nz);
                const nnx = nx / len;
                const nny = ny / len;
                const nnz = nz / len;

                data[idx + 0] = Math.floor((nnx * 0.5 + 0.5) * 255);
                data[idx + 1] = Math.floor((nny * 0.5 + 0.5) * 255);
                data[idx + 2] = Math.floor((nnz * 0.5 + 0.5) * 255);
                data[idx + 3] = 255;
            }
        }, (completed, total) => {
            if (onProgress) onProgress(completed / total);
        });

        ctx.putImageData(imageData, 0, 0);

        this.normalMap = new THREE.CanvasTexture(canvas);
        this.normalMap.wrapS = THREE.ClampToEdgeWrapping;
        this.normalMap.wrapT = THREE.ClampToEdgeWrapping;
        this.normalMap.generateMipmaps = true;
        this.normalMap.minFilter = THREE.LinearMipmapLinearFilter;
        this.normalMap.magFilter = THREE.LinearFilter;
        this.normalMap.anisotropy = 4;
        this.normalMap.needsUpdate = true;

        if (this.material) {
            this.material.uniforms.normalMap.value = this.normalMap;
            console.log(`CPU normal map applied to material (${width}x${height})`);
        }
    }

    /**
     * Check if any texel in the bilinear sampling neighborhood is NoData.
     * Used by the triangle filter to match what the GPU might sample.
     * @param {number} u - Normalized X (0-1)
     * @param {number} v - Normalized Y (0-1)
     * @returns {boolean}
     */
    _hasNearbyNoData(u, v) {
        const x = u * (this.elevationWidth - 1);
        const y = v * (this.elevationHeight - 1);
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(x0 + 1, this.elevationWidth - 1);
        const y1 = Math.min(y0 + 1, this.elevationHeight - 1);
        const w = this.elevationWidth;
        const d = this.elevationData;
        return this._isNoData(d[y0 * w + x0])
            || this._isNoData(d[y0 * w + x1])
            || this._isNoData(d[y1 * w + x0])
            || this._isNoData(d[y1 * w + x1]);
    }

    /**
     * Get elevation at a specific grid cell.
     * @param {number} x
     * @param {number} y
     * @returns {number} Elevation or NaN for NoData
     */
    _getElevationAt(x, y) {
        const index = y * this.elevationWidth + x;
        const value = this.elevationData[index];

        if (this._isNoData(value)) {
            return Number.NaN;
        }
        return value;
    }

    /**
     * Sample elevation using bilinear interpolation.
     * @param {number} u - Normalized X (0-1)
     * @param {number} v - Normalized Y (0-1)
     * @returns {number}
     */
    _sampleElevation(u, v) {
        if (!this.elevationData) return 0;

        const x = u * (this.elevationWidth - 1);
        const y = v * (this.elevationHeight - 1);

        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(x0 + 1, this.elevationWidth - 1);
        const y1 = Math.min(y0 + 1, this.elevationHeight - 1);

        const fx = x - x0;
        const fy = y - y0;

        const v00 = this._getElevationAt(x0, y0);
        const v10 = this._getElevationAt(x1, y0);
        const v01 = this._getElevationAt(x0, y1);
        const v11 = this._getElevationAt(x1, y1);

        // If any neighbor is NoData, treat this sample as NoData to avoid
        // creating false elevation values at boundaries
        if (!Number.isFinite(v00) || !Number.isFinite(v10) ||
            !Number.isFinite(v01) || !Number.isFinite(v11)) {
            return Number.NaN;
        }

        const vA = v00 * (1 - fx) + v10 * fx;
        const vB = v01 * (1 - fx) + v11 * fx;
        return vA * (1 - fy) + vB * fy;
    }

    /**
     * Set the Z-exaggeration factor.
     * @param {number} factor
     */
    setZExaggeration(factor) {
        this.zExaggeration = Math.max(
            this.config.minZExaggeration,
            Math.min(this.config.maxZExaggeration, factor)
        );

        if (this.useGPUDisplacement) {
            if (this.material?.uniforms?.heightScale) {
                this.material.uniforms.heightScale.value = this.zExaggeration / this.realWorldScale;
            }
        } else {
            this._updateVerticesCPU();
        }
    }

    /**
     * Set the normal map strength.
     * @param {number} scale - Normal map intensity (0 = flat, higher = stronger)
     */
    setNormalScale(scale) {
        if (this.material?.uniforms?.normalScale) {
            this.material.uniforms.normalScale.value = scale;
        }
    }

    getZExaggeration() {
        return this.zExaggeration;
    }

    getHeightScale() {
        const scale = this.zExaggeration / this.realWorldScale;
        return Number.isFinite(scale) && scale > 0 ? scale : 0.001;
    }

    /**
     * Get terrain height at a local XZ position.
     * @param {number} x
     * @param {number} z
     * @returns {number}
     */
    getHeightAtLocalPosition(x, z) {
        const halfWidth = this.modelWidth / 2;
        const halfHeight = this.modelHeight / 2;

        const u = (x + halfWidth) / this.modelWidth;
        const v = (z + halfHeight) / this.modelHeight;

        if (u < 0 || u > 1 || v < 0 || v > 1) return 0;

        const elevation = this._sampleElevation(u, v);
        if (!Number.isFinite(elevation)) return 0;

        const heightScale = this.getHeightScale();
        return (elevation - this.referenceElevation) * heightScale;
    }

    /**
     * Get depth at a local 3D position.
     * @param {THREE.Vector3} localPos
     * @returns {number|null}
     */
    getDepthAtLocalPosition(localPos) {
        if (!this.mesh) return null;

        const halfWidth = this.modelWidth / 2;
        const halfHeight = this.modelHeight / 2;

        if (localPos.x < -halfWidth || localPos.x > halfWidth ||
            localPos.z < -halfHeight || localPos.z > halfHeight) {
            return null;
        }

        const u = (localPos.x + halfWidth) / this.modelWidth;
        const v = (localPos.z + halfHeight) / this.modelHeight;

        const elevation = this._sampleElevation(u, v);

        return Math.max(0, this.referenceElevation - elevation);
    }

    /**
     * Convert local 3D position to geographic coordinates.
     * @param {THREE.Vector3} localPos
     * @returns {number[]|null} [x, y] in projected CRS
     */
    localToGeo(localPos) {
        if (!this.geoBounds) return null;

        const halfWidth = this.modelWidth / 2;
        const halfHeight = this.modelHeight / 2;

        const u = (localPos.x + halfWidth) / this.modelWidth;
        const v = (localPos.z + halfHeight) / this.modelHeight;

        if (u < 0 || u > 1 || v < 0 || v > 1) return null;

        const [minX, minY, maxX, maxY] = this.geoBounds;
        const geoX = minX + u * (maxX - minX);
        const geoY = maxY - v * (maxY - minY);

        return [geoX, geoY];
    }

    /**
     * Convert geographic coordinates to local 3D position.
     * @param {number} geoX
     * @param {number} geoY
     * @returns {THREE.Vector3|null}
     */
    geoToLocal(geoX, geoY) {
        if (!this.geoBounds) return null;

        const [minX, minY, maxX, maxY] = this.geoBounds;

        const u = (geoX - minX) / (maxX - minX);
        const v = (maxY - geoY) / (maxY - minY);

        if (u < 0 || u > 1 || v < 0 || v > 1) return null;

        const x = (u - 0.5) * this.modelWidth;
        const z = (v - 0.5) * this.modelHeight;

        return new THREE.Vector3(x, 0, z);
    }

    getMesh() { return this.mesh; }
    getGeometry() { return this.geometry; }
    getModelSize() { return Math.max(this.modelWidth, this.modelHeight); }
    getModelWidth() { return this.modelWidth; }
    getModelHeight() { return this.modelHeight; }
    getRealWorldScale() { return this.realWorldScale; }
    getRealWorldDimensions() { return { width: this.realWorldWidth, height: this.realWorldHeight }; }

    /**
     * Generate contour line segments using marching squares.
     * @param {number} referenceElevation - Reference elevation
     * @param {number} minElevation - Minimum elevation
     * @param {number} interval - Contour interval in meters
     * @param {number} heightOffset - Small Y offset to prevent z-fighting
     * @param {Function} [onProgress]
     * @param {number} [simplifyTolerance=0]
     * @param {number} [maxVertices=0] - Abort if vertex count exceeds this (0 = no limit)
     * @returns {{ segments: Float32Array, vertexCount: number, aborted: boolean }}
     */
    async generateContours(referenceElevation, minElevation, interval, heightOffset, onProgress, simplifyTolerance = 0, maxVertices = 0) {
        if (!this.elevationData || !this.gridWidth || !this.gridHeight) return null;

        const gw = this.gridWidth;
        const gh = this.gridHeight;
        const heightScale = this.getHeightScale();

        const maxContourDepth = Math.round(referenceElevation - minElevation);
        const thresholds = [];
        for (let depth = interval; depth <= maxContourDepth; depth += interval) {
            const ahdLevel = referenceElevation - depth;
            if (ahdLevel >= minElevation) {
                thresholds.push(ahdLevel);
            }
        }

        if (thresholds.length === 0) {
            console.warn('No contour thresholds generated');
            return { segments: new Float32Array(0), vertexCount: 0 };
        }

        const grid = new Float32Array(gw * gh);
        for (let gy = 0; gy < gh; gy++) {
            const v = gy / (gh - 1);
            for (let gx = 0; gx < gw; gx++) {
                const u = gx / (gw - 1);
                grid[gy * gw + gx] = this._sampleElevation(u, v);
            }
        }

        const halfW = this.modelWidth / 2;
        const halfH = this.modelHeight / 2;
        const modelX = new Float32Array(gw);
        const modelZ = new Float32Array(gh);
        for (let gx = 0; gx < gw; gx++) {
            modelX[gx] = (gx / (gw - 1)) * this.modelWidth - halfW;
        }
        for (let gy = 0; gy < gh; gy++) {
            modelZ[gy] = (gy / (gh - 1)) * this.modelHeight - halfH;
        }

        // Precompute per-vertex surface normals using central differences.
        // This ensures contour points on shared edges get identical offsets
        // regardless of which cell generates them.
        const cellW = this.modelWidth / (gw - 1);
        const cellH = this.modelHeight / (gh - 1);
        const vertexNormals = new Float32Array(gw * gh * 3);

        for (let gy = 0; gy < gh; gy++) {
            for (let gx = 0; gx < gw; gx++) {
                const idx = (gy * gw + gx) * 3;
                const c = grid[gy * gw + gx];
                if (c !== c) { // NaN
                    vertexNormals[idx] = 0;
                    vertexNormals[idx + 1] = 1;
                    vertexNormals[idx + 2] = 0;
                    continue;
                }

                const left  = gx > 0       ? grid[gy * gw + gx - 1] : c;
                const right = gx < gw - 1  ? grid[gy * gw + gx + 1] : c;
                const up    = gy > 0        ? grid[(gy - 1) * gw + gx] : c;
                const down  = gy < gh - 1   ? grid[(gy + 1) * gw + gx] : c;

                // Use center value as fallback for NaN neighbors
                const l = left === left ? left : c;
                const r = right === right ? right : c;
                const u = up === up ? up : c;
                const d = down === down ? down : c;

                const dx = (gx > 0 && gx < gw - 1) ? 2 : 1;
                const dz = (gy > 0 && gy < gh - 1) ? 2 : 1;

                const gradX = (r - l) / (dx * cellW) * heightScale;
                const gradZ = (d - u) / (dz * cellH) * heightScale;
                const nLen = Math.sqrt(gradX * gradX + 1 + gradZ * gradZ);
                vertexNormals[idx]     = -gradX / nLen;
                vertexNormals[idx + 1] = 1 / nLen;
                vertexNormals[idx + 2] = -gradZ / nLen;
            }
        }

        const segmentChunks = [];
        let totalVertices = 0;

        for (let ti = 0; ti < thresholds.length; ti++) {
            const threshold = thresholds[ti];
            const contourY = (threshold - referenceElevation) * heightScale;
            const chunkData = [];

            for (let gy = 0; gy < gh - 1; gy++) {
                const rowOffset = gy * gw;
                const nextRowOffset = (gy + 1) * gw;

                for (let gx = 0; gx < gw - 1; gx++) {
                    const tl = grid[rowOffset + gx];
                    const tr = grid[rowOffset + gx + 1];
                    const br = grid[nextRowOffset + gx + 1];
                    const bl = grid[nextRowOffset + gx];

                    if (tl !== tl || tr !== tr || br !== br || bl !== bl) continue;

                    const caseBits = (tl >= threshold ? 8 : 0)
                                   | (tr >= threshold ? 4 : 0)
                                   | (br >= threshold ? 2 : 0)
                                   | (bl >= threshold ? 1 : 0);

                    if (caseBits === 0 || caseBits === 15) continue;

                    let edges;
                    if (caseBits === 5) {
                        const center = (tl + tr + br + bl) * 0.25;
                        edges = center >= threshold
                            ? [[3, 0], [2, 1]]
                            : [[0, 1], [3, 2]];
                    } else if (caseBits === 10) {
                        const center = (tl + tr + br + bl) * 0.25;
                        edges = center >= threshold
                            ? [[0, 1], [3, 2]]
                            : [[3, 0], [2, 1]];
                    } else {
                        edges = MS_EDGE_TABLE[caseBits];
                    }

                    const x0 = modelX[gx];
                    const x1 = modelX[gx + 1];
                    const z0 = modelZ[gy];
                    const z1 = modelZ[gy + 1];

                    // Corner normal indices
                    const ntl = (gy * gw + gx) * 3;
                    const ntr = (gy * gw + gx + 1) * 3;
                    const nbr = ((gy + 1) * gw + gx + 1) * 3;
                    const nbl = ((gy + 1) * gw + gx) * 3;

                    for (const [e0, e1] of edges) {
                        const p0 = this._interpolateEdge(e0, threshold, tl, tr, br, bl, x0, x1, z0, z1);
                        const p1 = this._interpolateEdge(e1, threshold, tl, tr, br, bl, x0, x1, z0, z1);
                        const t0 = p0[2];
                        const t1 = p1[2];

                        // Interpolate normals from precomputed per-vertex normals
                        let n0i0, n0i1, n1i0, n1i1;
                        // Edge 0: tl→tr, Edge 1: tr→br, Edge 2: bl→br, Edge 3: tl→bl
                        switch (e0) {
                            case 0: n0i0 = ntl; n0i1 = ntr; break;
                            case 1: n0i0 = ntr; n0i1 = nbr; break;
                            case 2: n0i0 = nbl; n0i1 = nbr; break;
                            case 3: n0i0 = ntl; n0i1 = nbl; break;
                        }
                        switch (e1) {
                            case 0: n1i0 = ntl; n1i1 = ntr; break;
                            case 1: n1i0 = ntr; n1i1 = nbr; break;
                            case 2: n1i0 = nbl; n1i1 = nbr; break;
                            case 3: n1i0 = ntl; n1i1 = nbl; break;
                        }

                        const nx0 = vertexNormals[n0i0]     + t0 * (vertexNormals[n0i1]     - vertexNormals[n0i0]);
                        const ny0 = vertexNormals[n0i0 + 1] + t0 * (vertexNormals[n0i1 + 1] - vertexNormals[n0i0 + 1]);
                        const nz0 = vertexNormals[n0i0 + 2] + t0 * (vertexNormals[n0i1 + 2] - vertexNormals[n0i0 + 2]);

                        const nx1 = vertexNormals[n1i0]     + t1 * (vertexNormals[n1i1]     - vertexNormals[n1i0]);
                        const ny1 = vertexNormals[n1i0 + 1] + t1 * (vertexNormals[n1i1 + 1] - vertexNormals[n1i0 + 1]);
                        const nz1 = vertexNormals[n1i0 + 2] + t1 * (vertexNormals[n1i1 + 2] - vertexNormals[n1i0 + 2]);

                        chunkData.push(
                            p0[0] + nx0 * heightOffset, contourY + ny0 * heightOffset, p0[1] + nz0 * heightOffset,
                            p1[0] + nx1 * heightOffset, contourY + ny1 * heightOffset, p1[1] + nz1 * heightOffset
                        );
                    }
                }
            }

            if (chunkData.length > 0) {
                if (simplifyTolerance > 0) {
                    const simplified = this._chainAndSimplifySegments(chunkData, contourY, simplifyTolerance);
                    segmentChunks.push(simplified);
                    totalVertices += simplified.length / 3;
                } else {
                    segmentChunks.push(chunkData);
                    totalVertices += chunkData.length / 3;
                }
            }

            if (onProgress) onProgress((ti + 1) / thresholds.length);

            if (maxVertices > 0 && totalVertices > maxVertices) {
                console.warn(`Contour vertex limit (${(maxVertices / 1e6).toFixed(0)}M) exceeded at threshold ${ti + 1}/${thresholds.length} — aborting`);
                return { segments: new Float32Array(0), vertexCount: totalVertices, aborted: true };
            }

            await new Promise(r => setTimeout(r, 0));
        }

        const segments = new Float32Array(totalVertices * 3);
        let offset = 0;
        for (const chunk of segmentChunks) {
            segments.set(chunk, offset);
            offset += chunk.length;
        }

        console.log(`Generated ${totalVertices / 2} contour segments (${thresholds.length} thresholds, ${gw}x${gh} grid, simplify=${simplifyTolerance})`);
        return { segments, vertexCount: totalVertices, aborted: false };
    }

    /**
     * Chain raw marching-squares segments into polylines, simplify, then emit.
     */
    _chainAndSimplifySegments(data, contourY, tolerance) {
        const segCount = data.length / 6;
        if (segCount === 0) return data;

        const adj = new Map();
        const key = (x, z) => x + ',' + z;

        for (let i = 0; i < segCount; i++) {
            const ax = data[i * 6], az = data[i * 6 + 2];
            const bx = data[i * 6 + 3], bz = data[i * 6 + 5];
            const ka = key(ax, az);
            const kb = key(bx, bz);

            let la = adj.get(ka);
            if (!la) { la = []; adj.set(ka, la); }
            la.push({ seg: i, end: 0 });

            let lb = adj.get(kb);
            if (!lb) { lb = []; adj.set(kb, lb); }
            lb.push({ seg: i, end: 1 });
        }

        const used = new Uint8Array(segCount);
        const result = [];

        for (let i = 0; i < segCount; i++) {
            if (used[i]) continue;
            used[i] = 1;

            const ax = data[i * 6], az = data[i * 6 + 2];
            const bx = data[i * 6 + 3], bz = data[i * 6 + 5];

            const fwd = [];
            let curKey = key(bx, bz);
            for (;;) {
                const neighbors = adj.get(curKey);
                if (!neighbors) break;
                let found = false;
                for (const n of neighbors) {
                    if (used[n.seg]) continue;
                    used[n.seg] = 1;
                    const off = n.end === 0 ? n.seg * 6 + 3 : n.seg * 6;
                    const nx = data[off], nz = data[off + 2];
                    fwd.push(nx, nz);
                    curKey = key(nx, nz);
                    found = true;
                    break;
                }
                if (!found) break;
            }

            const bwd = [];
            curKey = key(ax, az);
            for (;;) {
                const neighbors = adj.get(curKey);
                if (!neighbors) break;
                let found = false;
                for (const n of neighbors) {
                    if (used[n.seg]) continue;
                    used[n.seg] = 1;
                    const off = n.end === 0 ? n.seg * 6 + 3 : n.seg * 6;
                    const nx = data[off], nz = data[off + 2];
                    bwd.push(nx, nz);
                    curKey = key(nx, nz);
                    found = true;
                    break;
                }
                if (!found) break;
            }

            const polyLen = (bwd.length / 2) + 2 + (fwd.length / 2);
            const poly = new Array(polyLen);
            let pi = 0;
            for (let j = bwd.length - 2; j >= 0; j -= 2) {
                poly[pi++] = [bwd[j], bwd[j + 1]];
            }
            poly[pi++] = [ax, az];
            poly[pi++] = [bx, bz];
            for (let j = 0; j < fwd.length; j += 2) {
                poly[pi++] = [fwd[j], fwd[j + 1]];
            }

            const simplified = this._simplifyPolyline2D(poly, tolerance);

            for (let j = 0; j < simplified.length - 1; j++) {
                result.push(
                    simplified[j][0], contourY, simplified[j][1],
                    simplified[j + 1][0], contourY, simplified[j + 1][1]
                );
            }
        }

        return result;
    }

    /**
     * Douglas-Peucker polyline simplification in 2D (XZ plane).
     */
    _simplifyPolyline2D(points, tolerance) {
        if (points.length <= 2) return points;

        const tolSq = tolerance * tolerance;
        const first = points[0];
        const last = points[points.length - 1];
        const dx = last[0] - first[0];
        const dz = last[1] - first[1];
        const lineLenSq = dx * dx + dz * dz;

        let maxDistSq = 0;
        let maxIdx = 0;

        if (lineLenSq < 1e-20) {
            for (let i = 1; i < points.length - 1; i++) {
                const px = points[i][0] - first[0];
                const pz = points[i][1] - first[1];
                const dSq = px * px + pz * pz;
                if (dSq > maxDistSq) { maxDistSq = dSq; maxIdx = i; }
            }
        } else {
            const invLen = 1 / lineLenSq;
            for (let i = 1; i < points.length - 1; i++) {
                const px = points[i][0] - first[0];
                const pz = points[i][1] - first[1];
                const t = (px * dx + pz * dz) * invLen;
                const ex = px - t * dx;
                const ez = pz - t * dz;
                const dSq = ex * ex + ez * ez;
                if (dSq > maxDistSq) { maxDistSq = dSq; maxIdx = i; }
            }
        }

        if (maxDistSq > tolSq) {
            const left = this._simplifyPolyline2D(points.slice(0, maxIdx + 1), tolerance);
            const right = this._simplifyPolyline2D(points.slice(maxIdx), tolerance);
            left.length--;
            return left.concat(right);
        }

        return [first, last];
    }

    /**
     * Interpolate crossing position along a marching squares cell edge.
     */
    _interpolateEdge(edge, threshold, tl, tr, br, bl, x0, x1, z0, z1) {
        let t;
        switch (edge) {
            case 0:
                t = (threshold - tl) / (tr - tl);
                return [x0 + t * (x1 - x0), z0, t];
            case 1:
                t = (threshold - tr) / (br - tr);
                return [x1, z0 + t * (z1 - z0), t];
            case 2:
                t = (threshold - bl) / (br - bl);
                return [x0 + t * (x1 - x0), z1, t];
            case 3:
                t = (threshold - tl) / (bl - tl);
                return [x0, z0 + t * (z1 - z0), t];
        }
    }

    /**
     * Clean up resources.
     */
    dispose() {
        if (this.geometry) {
            this.geometry.dispose();
            this.geometry = null;
        }

        if (this.material) {
            this.material.dispose();
            this.material = null;
        }

        if (this.mesh?.parent) {
            this.mesh.parent.remove(this.mesh);
        }
        this.mesh = null;

        if (this.normalMap) {
            this.normalMap.dispose();
            this.normalMap = null;
        }

        if (this.elevationTexture) {
            this.elevationTexture.dispose();
            this.elevationTexture = null;
        }

        this.elevationData = null;
        this.originalIndices = null;
    }
}

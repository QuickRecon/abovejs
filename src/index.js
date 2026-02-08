/**
 * abovejs - 3D terrain visualization library
 *
 * Main entry point with public exports.
 */

// Main orchestrator
export { TerrainViewer } from './TerrainViewer.js';

// Core modules
export { TerrainMesh } from './core/TerrainMesh.js';
export { OverlayLayers } from './core/OverlayLayers.js';
export { loadCOGFromUrl, loadCOGFromFile, extractCOGData } from './core/COGLoader.js';
export { analyzeElevation } from './core/ElevationAnalysis.js';
export { TURBO_COLORMAP, processInChunks } from './core/utils.js';

// Scene modules
export { ARScene } from './scene/ARScene.js';
export { ARManager, ARMode } from './scene/ARManager.js';

// AR modules
export { HandTracking, GestureType } from './ar/HandTracking.js';
export { HandMenu, MenuState, ToolType } from './ar/HandMenu.js';

// Tool modules
export { ToolManager } from './tools/ToolManager.js';
export { DepthProbeTool } from './tools/DepthProbeTool.js';
export { MeasureTool } from './tools/MeasureTool.js';
export { ProfileTool } from './tools/ProfileTool.js';

/**
 * LoadingProgress.js - 2D HTML overlay for loading progress
 *
 * Uses CSS animations for the spinner which continue running even when
 * JavaScript is blocked by heavy CPU work.
 */

/**
 * Loading stages with display names.
 */
export const LOADING_STAGES = [
    { key: 'LOAD_COG', name: 'Loading COG data' },
    { key: 'CREATE_TERRAIN', name: 'Building terrain mesh' },
    { key: 'COMPUTE_COLORS', name: 'Computing depth colors' },
    { key: 'FILTER_GEOMETRY', name: 'Optimizing geometry' },
    { key: 'GENERATE_NORMALS', name: 'Generating lighting' },
    { key: 'CREATE_CONTOURS', name: 'Creating contour lines' }
];

/**
 * LoadingProgress manages a 2D HTML overlay for showing loading progress.
 */
export class LoadingProgress {
    /**
     * @param {HTMLElement} container - Parent element to append overlay to
     */
    constructor(container) {
        this.container = container;
        this.overlay = null;
        this.stageEl = null;
        this.stepEl = null;
        this.barEl = null;
        this.percentEl = null;
        this.currentStageIndex = 0;

        this._findOrCreateElements();
    }

    /**
     * Find existing overlay elements.
     */
    _findOrCreateElements() {
        this.overlay = document.getElementById('ar-loading');
        this.stageEl = document.getElementById('ar-loading-stage');
        this.stepEl = document.getElementById('ar-loading-step');
        this.barEl = document.getElementById('ar-loading-bar');
        this.percentEl = document.getElementById('ar-loading-percent');

        if (!this.overlay) {
            console.warn('LoadingProgress: #ar-loading element not found in DOM');
        }
    }

    /**
     * Show the loading overlay.
     */
    show() {
        if (this.overlay) {
            this.overlay.style.display = 'flex';
        }
        this.setStage('LOAD_COG');
        this.setProgress(0);
    }

    /**
     * Hide the loading overlay.
     */
    hide() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
        }
    }

    /**
     * Set the current loading stage.
     * @param {string} stageKey
     */
    setStage(stageKey) {
        const stageIndex = LOADING_STAGES.findIndex(s => s.key === stageKey);
        if (stageIndex === -1) {
            console.warn(`LoadingProgress: Unknown stage key "${stageKey}"`);
            return;
        }

        this.currentStageIndex = stageIndex;
        const stage = LOADING_STAGES[stageIndex];

        if (this.stageEl) {
            this.stageEl.textContent = stage.name + '...';
        }

        if (this.stepEl) {
            this.stepEl.textContent = `Step ${stageIndex + 1} of ${LOADING_STAGES.length}`;
        }

        this.setProgress(0);
    }

    /**
     * Set the sub-stage progress.
     * @param {number} percent - 0-100
     */
    setProgress(percent) {
        const clamped = Math.max(0, Math.min(100, percent));

        if (this.barEl) {
            this.barEl.style.width = `${clamped}%`;
        }

        if (this.percentEl) {
            this.percentEl.textContent = `${Math.round(clamped)}%`;
        }
    }

    static get stageCount() {
        return LOADING_STAGES.length;
    }
}

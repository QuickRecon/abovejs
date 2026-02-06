# AR System

Covers ARScene.js, ARManager.js, and HandTracking.js.

## Scene Infrastructure (ARScene)

### Renderer Configuration

- WebGLRenderer with antialias, alpha (for AR passthrough), powerPreference 'high-performance'
- Pixel ratio capped at min(devicePixelRatio, 2)
- Output color space: SRGBColorSpace
- XR enabled, local clipping planes enabled
- Canvas appended to viewer-container element

### Camera

- PerspectiveCamera, FOV 70, near 0.01, far 100
- Desktop default position: (0, 0.5, 1), looking at origin
- Desktop init from ARManager: camera at (0, 0.4, 0.6)

### Lighting

- Ambient light: white, intensity 0.7
- Directional light: white, intensity 0.8, position (5, 10, 5), no shadows

### Model Container

- THREE.Group named 'modelContainer' added to scene root
- All terrain, contours, and tools are children of this group
- Transforms (position, rotation, scale) applied to this group for unified manipulation

### Desktop Controls (OrbitControls)

- Damping enabled, factor 0.1
- Screen-space panning
- Distance range: 0.1 to 5 meters
- Target: origin
- Disabled in AR mode

## Desktop vs AR Rendering

**Desktop 3D mode:**
- alpha: false (opaque background)
- OrbitControls enabled
- scene.background = null (transparent)

**AR mode:**
- alpha: true (passthrough)
- OrbitControls disabled
- scene.background = null
- Foveation set to 1 (maximum) for performance

## Render Loop

Every frame (via renderer.setAnimationLoop):
1. **If session paused** -- compensate pause drift, skip all app logic, render scene
2. **If not paused:**
   a. Save viewer position (for drift reference)
   b. Update OrbitControls (if desktop)
   c. Animate loading indicator (spin ring at 0.05 rad/frame)
   d. Call onRender callback (hand tracking + tool updates in AR)
   e. Render scene

The onRender callback (wired by ARManager) runs:
1. ToolManager.update(frame) -- runs BEFORE hand tracking so tool interactions can suppress map gestures
2. HandTracking.update(frame, modelContainer) -- gesture detection and model transforms

## AR Session Lifecycle (ARManager)

### AR Support Detection

- Checks navigator.xr.isSessionSupported('immersive-ar')
- If immersive-ar not supported but immersive-vr is, and user agent contains 'Quest' or 'Oculus' -- enables AR mode using VR fallback with passthrough

### Modes

NONE, DESKTOP_3D, AR

### Enter Desktop 3D

- If exiting another mode: detachReusableContent() + exitMode() first
- Creates fresh ARScene, inits with alpha:false
- Starts render loop
- Sets camera to (0, 0.4, 0.6)

### Enter AR (requires user gesture)

1. Request XR session FIRST (must be synchronous within user gesture -- any await before would break activation context)
   - Session type: 'immersive-ar' (or 'immersive-vr' for Quest VR fallback)
   - Required features: ['local-floor']
   - Optional features: ['hand-tracking', 'bounded-floor']
2. After session acquired: detach reusable content, exit old mode
3. Create fresh ARScene with alpha:true
4. Set XR session on renderer, foveation = 1
5. Wire session 'end' and 'visibilitychange' events
6. Start render loop
7. After 500ms delay: spawn model 0.7m in front of camera, 0.2m below eye height

### Exit AR

- End XR session, stop and dispose ARScene
- Create fresh ARScene instance for next use
- ARManager.onSessionEnd callback triggers desktop 3D rebuild

### Reusable Content Detachment

Before disposing a scene, ARManager.detachReusableContent() removes from the model container:
- terrainMesh.mesh
- overlayLayers.contourGroup
- Each tool's group

These objects survive disposal and get re-parented into the new scene's modelContainer via rebuildSceneContents().

## Pause-Drift Compensation

**Trigger:** XR session visibilitychange -- 'visible-blurred' or 'hidden'

**Problem:** During visible-blurred, Quest runtime throttles frame callbacks and may provide degraded viewer pose data. Between submitted frames, the compositor applies rotation-only ATW which cannot correct positional drift -- making the scene appear head-locked.

**Solution:**
- Every normal frame: save viewer position (from XRFrame.getViewerPose)
- When paused: compare current viewer position to last saved position, compute drift vector
- Shift modelContainer.position by drift to counter the movement
- On unpause: remove the accumulated compensation, reset to zero

**Pause also triggers:**
- HandTracking.onSessionPaused() -- resets all gesture state (pinch flags, velocities)
- ToolManager.reset() -- releases any grabbed tools, resets interaction state

## Hand Tracking

### Hand Setup

- Uses Three.js XRHandModelFactory with 'mesh' visual style
- hand0 = renderer.xr.getHand(0), hand1 = renderer.xr.getHand(1)
- Hand models added to scene
- Pinch events: Three.js built-in 'pinchstart'/'pinchend' events on hand objects

### Pinch Detection

- pinchThreshold: 0.025 meters (between thumb and index tip) -- but actual detection uses Three.js built-in events rather than distance check
- pinchIntentDelay: 100ms -- pinch must be held for 100ms before it becomes "active" (prevents accidental triggers)
- Tracks isPinching flag + pinchStartTime per hand

### Position Tracking

- Reads index-finger-tip joint world position each frame
- Stores current position and previous position per hand

### Tool Interaction Suppression

- When toolInteractionActive flag is set by ToolManager, all gestures return NONE
- Prevents map manipulation while grabbing/placing tools

## Gesture State Machine

**States:** NONE, DRAG, SCALE_ROTATE, Z_EXAGGERATION

**Detection logic (runs when not suppressed by tool interaction):**
- 0 hands active -- NONE
- 1 hand active (past intent delay) -- DRAG
- 2 hands active -- check hand vector verticality:
  - verticalRatio = |deltaY| / handDistance
  - If verticalRatio > verticalThreshold (0.7, approximately 45 degrees) -- Z_EXAGGERATION
  - Otherwise -- SCALE_ROTATE

**On gesture change:** captures start data (hand positions, distances, angles, model transform, pivot point in model-local coords)

### Drag Gesture

- Active hand index-finger-tip position tracked
- Delta from gesture start position
- Distance-based gain: gain = clamp(distanceToCamera / 0.7, 0.5, 2.0) -- farther hands move model faster
- Model position = startPosition + delta * gain

### Scale and Rotate Gesture

- Uses midpoint between hands as pivot
- Scale: ratio = currentHandDistance / startHandDistance, applied logarithmically (Math.exp(Math.log(ratio))) for consistent feel
- Scale clamped: 0.1 to realWorldScale (allows up to 1:1 real-world scale)
- Rotation: atan2(deltaX, deltaZ) between hands, delta from start angle applied to model Y rotation
- Pivot transform: localPivot (captured at start in model-local coords) -- scaled -- rotated -- model positioned so pivot lands at current midpoint

### Z-Exaggeration Gesture

- Absolute vertical distance between hands tracked (not signed separation)
- newExag = startExag + (currentVerticalDist - startVerticalDist) * sensitivity
- Hands apart = increase Z-exaggeration, hands together = decrease (consistent regardless of which hand is higher)
- zExaggerationSensitivity: 20 units per meter of vertical hand movement
- Applied via terrainMesh.setZExaggeration() which clamps to 1-10 range
- Callback updates overlay layers and sidebar slider
- **Visual indicator:** Cyan cylinder (0x4fc3f7, radius 0.003m, opacity 0.8) connecting hands during gesture, hidden otherwise

## Inertia System

- On gesture end (both hands released from DRAG): captures velocity = (currentPos - prevPos) * 60
- Each frame with no active gesture: applies velocity with exponential damping
- positionDamping: 100 (very fast decay)
- rotationDamping: 8 (not currently used -- angular velocity captured but not applied)
- scaleDamping: 8 (not currently used -- scale velocity captured but not applied)
- Velocity threshold: lengthSq > 0.0001

## Loading Indicator (3D, in ARScene)

- Spinning torus (radius 0.05, tube 0.008) + center sphere (radius 0.01) + text sprite + progress bar
- Color: 0x4fc3f7 (light blue)
- Positioned 0.5m in front of camera, facing camera
- In AR mode: updates position each frame to follow camera
- Spinner rotation: -0.05 rad/frame

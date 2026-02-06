# Tools and Menus

This document describes the AR tool system: tool lifecycle management, the palm-anchored hand menu, the depth probe tool, and the measure tool. Values and behaviors stated here are authoritative -- editing a value communicates a desired code change.

---

## Tool Manager Lifecycle

**Initialization:** ToolManager receives scene, camera, modelContainer, terrainMesh, hand0, hand1, and handStates. Creates a HandMenu and adds it to the scene.

**Update Loop (runs before HandTracking each frame):**

1. Update hand menu (positioning, icon visibility, selection detection)
2. Detect pinch edges (rising/falling) by comparing current frame pinch state to previous frame
3. Handle active grab state (menu-grab or existing-tool-grab)
4. If no active grab: check proximity of hands to placed tools, highlight nearest, start grab on pinch
5. Update all placed tools (terrain snapping, distance computation)
6. Notify interaction state changes (active/inactive) -- HandTracking suppresses map gestures when active

**Interaction State:** `grabbedTool !== null || menuGrabTool !== null` suppresses all HandTracking map gestures.

---

## Tool Creation Flow

1. User turns hand palm-down -- menu disc appears on back of hand
2. Other hand approaches menu -- tool icons appear (Depth, Measure)
3. Finger near icon -- icon highlights, arc highlight shows
4. Pinch on icon -- new tool created at menu position in model-local space
5. Tool enters "menu grab" state -- entire tool group follows pinching finger
6. Release pinch -- tool placed at current position
7. If released near menu (within MENU_RADIUS = **0.045 m**) -- tool deleted instead of placed

---

## Grab System

### Menu Grab (new tool from menu)

- Tool group follows index-finger-tip in model-local coordinates
- For MeasureTool: both dots stay at their default offsets from the group origin (no individual dot grabbing during menu grab)
- Release: place tool in tools array, or delete if in delete zone
- If hand/joint data lost during grab: releases the tool (prevents stuck grab state)

### Existing Tool Grab

- Pinch start near an interaction point -- startGrab(pointIndex) on that tool
- Grabbed point follows index-finger-tip via tool.updateGrab(localPos)
- Delete icon shown/hidden based on proximity to menu during drag
- Release near menu delete zone -- tool removed from tools array and disposed
- Release elsewhere -- tool.endGrab(terrainMesh) snaps to terrain

### One Grab at a Time

Only one tool/point can be grabbed. First hand to pinch near a point wins.

---

## Proximity Detection and Highlighting

- PROXIMITY_THRESHOLD: **0.05 m** (5 cm in world space)
- Each frame (when no grab active): for each hand, find nearest interaction point across all placed tools
- If within threshold: highlight that point (show highlight ring/arc)
- Pinch start within threshold -- initiates grab

---

## Hand Menu

### Positioning

- Anchored to the back of the menu hand (the hand whose palm faces away from camera)
- Uses middle-finger-phalanx-proximal (knuckle) joint for centering, fallback to middle-finger-metacarpal
- Offset **0.03 m** along back-of-hand normal to float above hand surface
- Oriented: disc normal aligned with knuckle's +Y (back-of-hand direction)

### Visibility State Machine

States: HIDDEN, VISIBLE, ACTIVE, SELECTING

Detection per frame:

1. For each hand: compute palm normal dot product with vector-to-camera
2. If dot < BACK_OF_HAND_THRESHOLD (**-0.3**) -- hand's back faces camera
3. Best candidate = most negative dot product

### Hysteresis

- HYSTERESIS_MS: **200 ms**
- Both show and hide transitions must persist for 200 ms before taking effect
- Prevents flickering when hand orientation is borderline

### Distance-Based States

- Interacting hand > HAND_PROXIMITY_DISTANCE (**0.15 m**) from menu -- HIDDEN
- Interacting hand > ACTIVATION_DISTANCE (**0.12 m**) from menu -- VISIBLE (disc only, no icons)
- Interacting hand <= ACTIVATION_DISTANCE -- ACTIVE (disc + icons visible)

### Tool Icons

- Three tools evenly spaced at 120° intervals: Depth Probe (angle pi/2, top), Profile (angle -pi/6, bottom-right), Measure (angle -5pi/6, bottom-left)
- ICON_OFFSET: **0.027 m** from center
- Icons are text sprites with cyan color (0x4fc3f7), highlight to white when selected
- Highlight arc (ring segment) rotates to selected icon's angle

### Selection Trigger

- Finger within SELECT_DISTANCE (**0.035 m**) of icon -- SELECTING state, icon highlighted
- Pinch while selecting -- onToolSelected callback fires with tool type and menu world position

### Delete Zone

- Center of menu, within MENU_RADIUS (**0.045 m**)
- Delete icon ("X" in red, 0xff4444) shown when a tool grab is active
- isInDeleteZone checks world-space distance to menu position

### Menu Visuals

- Semi-transparent dark disc (0x222222, opacity **0.7**, depthTest false)
- MENU_RADIUS: **0.045 m**, 32 segments
- All menu elements use depthTest:false and renderOrder for proper layering

---

## Depth Probe Tool

### Visuals

- Label sprite: 512x96 canvas, fontSize **36**, spriteScale **0.12**, positioned **0.06 m** above group origin
- Vertical line from label (Y=0.05) down to terrain contact point
- Contact sphere: radius **0.004 m**, cyan (0x00e5ff), depthTest false
- Highlight ring: inner **0.008**, outer **0.014**, cyan, depthTest false, horizontal orientation

### Terrain Snapping

- Every frame (when not grabbed): queries terrainMesh.getHeightAtLocalPosition(x, z)
- Contact sphere and highlight ring snap to terrain Y
- Line bottom endpoint tracks terrain Y

### Elevation Display

- Throttled at **100 ms** (10 Hz) via throttle utility
- Computes UV from model-local position, samples elevation via terrainMesh._sampleElevation
- Displays: "{elevation}m ({depth}m below ref)" where depth = referenceElevation - elevation
- Off-map: "Off map", NoData: "No data"

### Grab Behavior

- Single interaction point (the probe position)
- While grabbed: group.position follows localPos directly, terrain query skipped
- On endGrab: snaps Y to terrain height

### Clamped Scaling

- Contact sphere: base **0.004**, world range [**0.005**, **0.025**]
- Label: base **0.12**, world range [**0.04**, **0.18**]
- Uses clampedElementScale() to keep elements usable at any model scale

---

## Measure Tool

### Visuals

- Two red dots (0xff4444): sphere radius **0.008 m**, depthTest false
- Direction arrow: red cone (0xff4444), positioned 85% along line from A to B, points in direction of travel
- Connecting white line (opacity **0.8**, depthTest false, frustumCulled false)
- Label sprite: 512x280 canvas (5 lines), fontSize **24**, spriteScale **0.16**, background rgba(0,0,0,0.7)
- Highlight rings per dot: inner **0.012**, outer **0.02**, red, depthTest false
- Initial dot positions: dotA at (-0.02, 0, 0), dotB at (0.02, 0, 0) relative to group origin

### Two-Dot System

- Each dot is an independent interaction point (index 0 = dotA, index 1 = dotB)
- Dots snap to terrain surface independently each frame (unless currently grabbed)
- Only the non-grabbed dot gets terrain-snapped; grabbed dot follows finger

### Distance Computation (throttled at 100 ms)

Five measurements displayed on the label:

1. **H (horizontal):** model-local XZ distance x realWorldScale -- real-world horizontal distance
2. **deltaH (height difference):** raw elevation difference between dot positions (elevB - elevA), signed with +/- prefix
3. **3D distance:** hypot(horizontalDist, elevationDiff) in real-world meters
4. **Bearing:** compass direction from A to B in degrees (0° = North, 90° = East, etc.)
5. **Azimuth:** vertical inclination angle in degrees (positive = uphill from A to B)

### Label Rendering

- Direct canvas rendering with rounded-rect background
- 5 lines at equal vertical spacing: "H: {dist}" (white), "ΔH: {+/-dist}" (gray #aaaaaa), "3D: {dist}" (cyan #4fc3f7), "Bearing: {deg}°" (gold #ffc107), "Azimuth: {+/-deg}°" (orange #ff9800)
- Distance formatting: <1 m -- cm with 1 decimal, <1000 m -- m with 1 decimal, >=1000 m -- km with 2 decimals

### Grab Behavior (per endpoint)

- Pinch near dotA -- grab index 0; near dotB -- grab index 1
- Grabbed dot: XZ follows finger, Y follows finger (not terrain-snapped during grab)
- Non-grabbed dot: continues terrain snapping normally
- endGrab: clears grabbedIndex, next updateInWorld() snaps dot to terrain

### Clamped Scaling

- Dots: base **0.008**, world range [**0.005**, **0.025**]
- Direction arrow: base **0.006**, world range [**0.004**, **0.02**]
- Highlight rings: same scale as dots
- Label: base **0.16**, world range [**0.05**, **0.20**], maintains 512:280 aspect ratio

---

## Profile Tool

### Purpose

Displays an elevation profile between two draggable endpoints with a terrain-following line. A movable marker slides along the profile showing distances from each endpoint and elevation at that point.

### Visuals

- Two green endpoint dots (0x4caf50): sphere radius **0.008 m**, depthTest false (distinct from red MeasureTool)
- Direction arrow: green cone (0x4caf50), positioned 85% along line from A to B, points in direction of travel
- Cyan profile line (0x00e5ff): follows terrain surface with **80** sample points, opacity **0.9**, depthTest false, frustumCulled false
- Gold marker dot (0xffc107): sphere radius **0.006 m**, depthTest false, slides along profile
- Label sprite: 512x256 canvas (4 lines), fontSize **26**, spriteScale **0.16**, positioned **0.04 m** above marker
- Highlight rings: green for endpoints (inner **0.012**, outer **0.02**), gold for marker

### Three-Point Interaction System

Marker is returned first so it wins proximity ties when at endpoints:

- Index 0 = marker (constrained to profile line) -- **priority for interaction**
- Index 1 = dotA (profile start endpoint)
- Index 2 = dotB (profile end endpoint)

### Profile Computation (throttled at 100 ms)

- Samples **80** points linearly between A and B in XZ
- At each sample: queries terrain height via getHeightAtLocalPosition, samples raw elevation via _sampleElevation
- Computes cumulative 3D distance along terrain-following path (real-world units via realWorldScale)
- Stores: position (group-local), cumulative distance from A, raw elevation, normalized t value

### Marker Behavior

- markerT value [0, 1] determines position along profile by distance fraction
- When grabbed (index 0): projects pinch position onto profile line, updates markerT to nearest point
- Marker cannot leave the profile path -- always constrained to line
- Marker has interaction priority over endpoints when at same position

### Label Display (throttled at 100 ms)

Four lines, centered:

1. "From A: {dist}" (white) -- distance along profile from A to marker
2. "From B: {dist}" (gray #aaaaaa) -- distance along profile from marker to B
3. "Elev: {elevation}m ({depth}m below ref)" (gold #ffc107) -- interpolated elevation and depth below reference
4. "Bearing: {deg}°" (cyan #4fc3f7) -- compass direction from A to B

Distance formatting: same as MeasureTool (<1 m -- cm, <1000 m -- m, >=1000 m -- km)

### Endpoint Grab Behavior

- Same as MeasureTool: grabbed endpoint follows finger, non-grabbed endpoint terrain-snaps
- Profile recomputed after endpoint move (throttled)
- markerT preserved during endpoint moves (marker stays at same proportional position)

### Clamped Scaling

- Endpoint dots: base **0.008**, world range [**0.005**, **0.025**]
- Direction arrow: base **0.006**, world range [**0.004**, **0.02**]
- Marker: base **0.006**, world range [**0.004**, **0.02**]
- Highlight rings: same scale as their respective dots
- Label: base **0.16**, world range [**0.05**, **0.20**], maintains 512:256 aspect ratio

---

## Shared Utilities (ToolUtils)

**createTextSprite:** Creates billboard THREE.Sprite with CanvasTexture. Options: fontSize (default **48**), fontFamily ('Arial'), color ('#ffffff'), backgroundColor (optional rounded-rect fill), canvasWidth (**512**), canvasHeight (**128**), spriteScale (**0.15**). Stores canvas/texture refs in userData for updates.

**updateTextSprite:** Redraws canvas text and flags texture for GPU upload. Supports optional rounded-rect background.

**worldToLocal:** Converts XR world position to model-local: subtract container position, undo Y rotation, divide by container scale.

**localToWorld:** Converts model-local to XR world: multiply by container scale, apply Y rotation, add container position.

**clampedElementScale:** Given geometry size and container scale, returns a scale factor to keep world-space size within [min, max]. Returns 1 if already within bounds.

**throttle:** Simple time-based throttle using performance.now(). Drops calls within interval window. Used by DepthProbeTool (**100 ms**) and MeasureTool (**100 ms**).

# above.js

Interactive 3D visualization of Cloud Optimized GeoTIFF (COG) elevation data in the browser.

Supports desktop viewing with orbit controls and immersive WebXR AR on Meta Quest headsets with hand tracking.

Based on [below.js](https://github.com/patrick-morrison/belowjs) by Patrick Morrison.

## Usage

Serve with any static HTTP server

Open `index.html`, then upload a COG file or paste a URL. Several bundled examples are included.

For WebXR AR features, HTTPS is required.

## Dependencies

All loaded via CDN — nothing to install:

- [Three.js](https://threejs.org/) r160
- [GeoTIFF.js](https://geotiffjs.github.io/) 2.1.3

## Features

- GPU-accelerated terrain rendering with custom GLSL shaders
- Turbo colormap elevation coloring
- Adjustable Z-exaggeration (vertex shader uniform, no mesh rebuild)
- Contour line overlay via marching squares
- Normal map generation from full-resolution elevation data
- WebXR AR with hand tracking, pinch gestures, and palm-anchored menus
- AR measurement and depth probe tools
- NoData-aware elevation processing

## Example Data

Most bundled examples are derived from bathymetry surveys conducted by the [Western Australian Department of Transport](https://www.transport.wa.gov.au/), available through the [DOT Bathymetry Portal](https://dot-wa.maps.arcgis.com/apps/webappviewer/index.html?id=d58dd77d85654783b5fc8c775953c69b).

| Example | Location | Survey ID | Method | Date |
|---------|----------|-----------|--------|------|
| Wellington | Wellington Dam, Peel | AS20130627 and AS20131211 | Multibeam | 2013 |
| Swan River | Swan River | SC20101001 | Multibeam | 2010-01-10 |
| Kepwari | Lake Kepwari, Collie | LK20200523 | Multibeam | 2020-05-23 |
| Logue Brook | Logue Brook Dam | LK20240516 | Multibeam | 2024-05-16|

The Stockton example is derived from bathymetry of Lake Stockton, a coal mine pit lake in the Collie Basin. The bathymetry was surveyed by boat with sonar in April 2010 as part of the Mine Voids Management Strategy. See Figure 17 in:

> Muller, M.; Eulitz, K.; McCullough, C. D. & Lund, M. A. (2010). *Mine Voids Management Strategy (V): Water Quality Modelling of Collie Basin Pit Lakes.* MiWER/Centre for Ecosystem Management Report 2010-10, Edith Cowan University, Perth, Australia.

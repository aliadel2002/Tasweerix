/**
 * @tasweerix/3d — true 3D scenes inside compositions: meshes, extruded paths and text, glTF/OBJ
 * models, PBR-style materials, lights with shadows, animated cameras, and 2D layers (video,
 * comps, text) placed in 3D space. Rendered by a WebGL2 renderer into a 2D layer.
 */
import './draw';

export * from './math3d';
export * from './geometry';
export * from './triangulate';
export * from './loaders';
export * from './text3d';
export * from './nodes';
export * from './evaluate';
export * from './renderer3d';
export { renderer3dFor } from './draw';

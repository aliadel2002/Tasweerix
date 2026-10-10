export * from './surface';
export * from './gl';
export * from './assets';
export * from './filters';
export * from './fx';
export * from './transitions';
export * from './text';
export * from './paint';
export * from './renderer';
export * from './draw';

import { onPlugin } from '@tasweerix/core';
import { registerDrawer, type Drawer, type DrawerOptions } from './renderer';
import { registerFilter, type FilterImpl } from './filters';
import { registerTransition, type TransitionImpl } from './transitions';

// Plugins contribute drawers, GPU filters and transitions.
onPlugin((p) => {
  for (const [kind, d] of Object.entries(p.drawers ?? {})) {
    const def = d as Drawer | { draw: Drawer; options?: DrawerOptions };
    if (typeof def === 'function') registerDrawer(kind, def);
    else registerDrawer(kind, def.draw, def.options);
  }
  for (const [kind, f] of Object.entries(p.filters ?? {})) registerFilter(kind, f as FilterImpl);
  for (const [kind, t] of Object.entries(p.transitions ?? {})) registerTransition(kind, t as TransitionImpl);
});

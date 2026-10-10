export * from './buffer';
export * from './wav';
export * from './dsp/fft';
export * from './dsp/biquad';
export * from './dsp/dynamics';
export * from './dsp/time';
export * from './dsp/reverb';
export * from './dsp/stretch';
export * from './dsp/processor';
export * from './loudness';
export * from './analysis';
export * from './synth';
export * from './effects';
export * from './mixer';
export * from './reactive';

import { onPlugin } from '@tasweerix/core';
import { registerAudioEffect } from './effects';
import { registerGenerator, type GeneratorImpl } from './synth';
import type { ProcessorFactory } from './dsp/processor';

// Plugins contribute audio effects and generators.
onPlugin((p) => {
  for (const [kind, f] of Object.entries(p.audioEffects ?? {})) registerAudioEffect(kind, f as ProcessorFactory);
  for (const [kind, g] of Object.entries(p.generators ?? {})) registerGenerator(kind, g as GeneratorImpl);
});

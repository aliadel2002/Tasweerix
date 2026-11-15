export * from './text';
export * from './behaviors';
export * from './morph';
export * from './particles';
export * from './layout';
export * from './charts';
export * from './presets';
export * from './arabic';

import { enterFx, exitFx, loopFx } from './behaviors';
import { textFx, scramble, counter } from './text';
import { morph } from './morph';
import { particles, particlePresets } from './particles';
import { repeat, followPath } from './layout';
import { barChart, lineChart, pieChart, numberCounter, progressBar } from './charts';
import { lowerThird, titleCard, callout, spectrumBars } from './presets';
import { arabicFx, bilingualTitle } from './arabic';

/** Everything motion-graphics in one namespace: `motion.enter.fade()`, `motion.text.pop()` … */
export const motion = {
  enter: enterFx,
  exit: exitFx,
  loop: loopFx,
  text: textFx,
  arabic: arabicFx,
  scramble,
  counter,
  morph,
  particles,
  particlePresets,
  repeat,
  followPath,
  barChart,
  lineChart,
  pieChart,
  numberCounter,
  progressBar,
  lowerThird,
  titleCard,
  bilingualTitle,
  callout,
  spectrumBars,
};

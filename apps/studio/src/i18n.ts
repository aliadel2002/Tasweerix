import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

/**
 * Studio interface text in English and Arabic. Property names in the inspector, file names and code are
 * never translated: they are what you type in the source.
 */
const en = {
  project: 'Project',
  timeline: 'Timeline',
  export: 'Export',
  play: 'Play',
  pause: 'Pause',
  toStart: 'Go to start',
  prevFrame: 'Previous frame',
  nextFrame: 'Next frame',
  loop: 'Loop playback',
  guides: 'Safe areas and thirds',
  undo: 'Undo',
  redo: 'Redo',
  previewScale: 'Preview resolution',
  exportFormat: 'Export format',
  composition: 'Composition',
  frameOf: (ext: string) => `${ext} frame`,
  autosave: 'saves automatically',
  dropHint: 'Drop files here to add them to assets/',
  useAsEntry: 'Use as the entry file',
  copySnippet: (code: string) => `Copy ${code}`,
  openFile: (path: string) => `Open ${path}`,
  selectHint: 'Select an element on the canvas or timeline.',
  showInCode: 'Show in code',
  inCode: 'animated or computed in code',
  computed: (prop: string) => `${prop} is animated or computed in code. Edit it there.`,
  unmapped: 'Could not map this element to source',
  timing: 'Timing',
  transform: 'Transform',
  appearance: 'Appearance',
  content: 'Content',
  filters: 'Filters',
  open: 'open',
  zoom: 'Timeline zoom',
  fit: 'Fit the whole timeline',
  snap: 'Snap to the playhead, markers and other clips',
  collapse: 'Collapse',
  expand: 'Expand',
  clip: (name: string) => `Clip ${name}. Arrow keys move it by one frame.`,
  keyframe: (prop: string, t: string) => `${prop} keyframe at ${t}s`,
  trimStart: 'Trim start',
  trimEnd: 'Trim end',
  rotateHandle: 'Rotate',
  scaleHandle: 'Scale',
  run: 'Run',
  working: 'Working…',
  done: 'Done',
  exportStarted: 'Export started…',
  exporting: (done: number, total: number, fps: string) => `Exporting ${done}/${total} · ${fps} fps`,
  exported: (file: string, s: string) => `Exported ${file} (${s}s)`,
  exportFailed: (e: string) => `Export failed: ${e}`,
  language: 'Language',
  codeEditor: 'Code editor',
  resizePanel: 'Resize panel',
  canvas: 'Preview canvas. Click an element to select it, drag to move it.',
};

export type Strings = typeof en;

const ar: Strings = {
  project: 'المشروع',
  timeline: 'الخط الزمني',
  export: 'تصدير',
  play: 'تشغيل',
  pause: 'إيقاف مؤقت',
  toStart: 'الانتقال إلى البداية',
  prevFrame: 'الإطار السابق',
  nextFrame: 'الإطار التالي',
  loop: 'تكرار التشغيل',
  guides: 'المناطق الآمنة وخطوط الأثلاث',
  undo: 'تراجع',
  redo: 'إعادة',
  previewScale: 'دقة المعاينة',
  exportFormat: 'صيغة التصدير',
  composition: 'التكوين',
  frameOf: (ext) => `إطار ${ext}`,
  autosave: 'يُحفظ تلقائيًا',
  // The folder name is isolated so its slash stays on the right of the name.
  dropHint: 'أفلت الملفات هنا لإضافتها إلى \u2066assets/\u2069',
  useAsEntry: 'استخدامه ملفًا رئيسيًا',
  copySnippet: (code) => `نسخ ${code}`,
  openFile: (path) => `فتح ${path}`,
  selectHint: 'اختر عنصرًا من اللوحة أو من الخط الزمني.',
  showInCode: 'إظهاره في الشيفرة',
  inCode: 'متحرك أو محسوب في الشيفرة',
  computed: (prop) => `الخاصية ${prop} متحركة أو محسوبة في الشيفرة. عدّلها هناك.`,
  unmapped: 'تعذّر ربط هذا العنصر بالشيفرة المصدرية',
  timing: 'التوقيت',
  transform: 'التحويل',
  appearance: 'المظهر',
  content: 'المحتوى',
  filters: 'المرشّحات',
  open: 'مفتوحة',
  zoom: 'تكبير الخط الزمني',
  fit: 'إظهار الخط الزمني كاملًا',
  snap: 'الالتصاق بمؤشر التشغيل والعلامات والمقاطع الأخرى',
  collapse: 'طيّ',
  expand: 'توسيع',
  clip: (name) => `المقطع ${name}. مفاتيح الأسهم تحرّكه إطارًا واحدًا.`,
  keyframe: (prop, t) => `إطار مفتاحي للخاصية ${prop} عند ${t} ث`,
  trimStart: 'قصّ البداية',
  trimEnd: 'قصّ النهاية',
  rotateHandle: 'تدوير',
  scaleHandle: 'تغيير الحجم',
  run: 'تنفيذ',
  working: 'جارٍ العمل…',
  done: 'تمّ',
  exportStarted: 'بدأ التصدير…',
  exporting: (done, total, fps) => `جارٍ التصدير ${done}/${total} · ${fps} إطار/ث`,
  exported: (file, s) => `تمّ تصدير ${file} (${s} ث)`,
  exportFailed: (e) => `فشل التصدير: ${e}`,
  language: 'اللغة',
  codeEditor: 'محرّر الشيفرة',
  resizePanel: 'تغيير حجم اللوحة',
  canvas: 'لوحة المعاينة. انقر عنصرًا لاختياره، واسحبه لتحريكه.',
};

export type Locale = 'en' | 'ar';
export const LOCALES: Record<Locale, { name: string; dir: 'ltr' | 'rtl'; strings: Strings }> = {
  en: { name: 'English', dir: 'ltr', strings: en },
  ar: { name: 'العربية', dir: 'rtl', strings: ar },
};

const KEY = 'tasweerix.studio.locale';

/** The saved choice, else Arabic for an Arabic browser, else English. */
export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'ar') return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && /^ar\b/i.test(navigator.language ?? '') ? 'ar' : 'en';
}

export function saveLocale(l: Locale): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* storage unavailable */
  }
}

export const I18n = createContext<Strings>(en);
export const useT = (): Strings => useContext(I18n);

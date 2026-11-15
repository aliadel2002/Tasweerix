/** Studio icons: 16 px line drawings on one grid, drawn in the current text color. */
const PATHS = {
  toStart: 'M4 3v10 M13 3.5L6.5 8l6.5 4.5z',
  prevFrame: 'M11 3.5L5 8l6 4.5z M3.5 4v8',
  nextFrame: 'M5 3.5L11 8l-6 4.5z M12.5 4v8',
  play: 'M4.5 2.5L13 8l-8.5 5.5z',
  pause: 'M5 3v10 M11 3v10',
  loop: 'M3 8a5 5 0 0 1 8.5-3.5L13 6 M13 2.5V6H9.5 M13 8a5 5 0 0 1-8.5 3.5L3 10 M3 13.5V10h3.5',
  guides: 'M2.5 2.5h11v11h-11z M6.2 2.5v11 M9.8 2.5v11 M2.5 6.2h11 M2.5 9.8h11',
  undo: 'M6 3.5L2.5 7 6 10.5 M2.5 7h7a4 4 0 0 1 0 8H7',
  redo: 'M10 3.5L13.5 7 10 10.5 M13.5 7h-7a4 4 0 0 0 0 8H9',
  copy: 'M5.5 5.5h8v8h-8z M10.5 5.5v-3h-8v8h3',
  entry: 'M3 2.5h7l3 3v8H3z M6.5 6.5l3.5 2.5-3.5 2.5z',
  code: 'M5.5 4.5L2 8l3.5 3.5 M10.5 4.5L14 8l-3.5 3.5 M9 3l-2 10',
  chevron: 'M6 4l4 4-4 4',
  fit: 'M2.5 6V2.5H6 M10 2.5h3.5V6 M13.5 10v3.5H10 M6 13.5H2.5V10',
  magnet: 'M3.5 2.5v5.5a4.5 4.5 0 0 0 9 0V2.5h-3V8a1.5 1.5 0 0 1-3 0V2.5z M3.5 5h3 M9.5 5h3',
  fileCode: 'M3.5 2h6l3 3v9h-9z M9.5 2v3h3 M6.8 8.2L5.5 9.7l1.3 1.5 M9.2 8.2l1.3 1.5-1.3 1.5',
  fileVideo: 'M2.5 3.5h11v9h-11z M6.5 6l3.5 2-3.5 2z',
  fileImage: 'M2.5 3h11v10h-11z M2.5 11l3.5-3.5 2.5 2.5 2-2 3 3 M10.3 5.8h.01',
  fileAudio: 'M6 12.5a1.8 1.8 0 1 1-1.8-1.8H6V3.5l6.5-1.3v8.5a1.8 1.8 0 1 1-1.8-1.8h1.8 M6 5.8l6.5-1.3',
  fileText: 'M3.5 2h6l3 3v9h-9z M9.5 2v3h3 M5.5 8h5 M5.5 10.5h5',
  globe: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z M2 8h12 M8 2c2 2 2 10 0 12 M8 2c-2 2-2 10 0 12',
} as const;

export type IconName = keyof typeof PATHS;
const FILLED = new Set<IconName>(['play', 'toStart', 'prevFrame', 'nextFrame']);

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill={FILLED.has(name) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * The Tasweerix mark: the letter ت, the first letter of تصوير, with the diamond dots a reed pen makes.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg class="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M27 8.500c0 9-3 13.500-11 13.500C8.500 22 5 19.500 5 14" fill="none" stroke="currentColor" stroke-width="3.800" stroke-linecap="round" />
      <path d="M12.800 4l2.600 2.600-2.600 2.600-2.600-2.600z M18 4l2.600 2.600L18 9.200 15.400 6.600z" fill="var(--accent, currentColor)" />
    </svg>
  );
}

const EXT_ICON: Record<string, IconName> = {
  ts: 'fileCode', tsx: 'fileCode', js: 'fileCode', mjs: 'fileCode', json: 'fileCode',
  mp4: 'fileVideo', mov: 'fileVideo', webm: 'fileVideo', mkv: 'fileVideo',
  png: 'fileImage', jpg: 'fileImage', jpeg: 'fileImage', webp: 'fileImage', gif: 'fileImage', svg: 'fileImage', avif: 'fileImage', tif: 'fileImage', tiff: 'fileImage',
  mp3: 'fileAudio', wav: 'fileAudio', m4a: 'fileAudio', flac: 'fileAudio', ogg: 'fileAudio', opus: 'fileAudio',
};
export const fileIcon = (ext: string): IconName => EXT_ICON[ext] ?? 'fileText';

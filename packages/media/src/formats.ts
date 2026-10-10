/** Camera RAW file extensions decoded through LibRaw (DNG and the common vendor formats). */
export const RAW_EXTENSIONS = ['dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl', 'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'erf', 'mrw', 'kdc', 'dcr', 'mos', 'mef'];

const RAW_RE = new RegExp(`\\.(${RAW_EXTENSIONS.join('|')})$`, 'i');

/** True for a camera RAW file name. */
export function isRawPath(src: string): boolean {
  return RAW_RE.test(src.split(/[?#]/)[0]!);
}

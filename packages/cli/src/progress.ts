/** Single-line terminal progress bar. */
export function progressBar(label: string) {
  const tty = process.stderr.isTTY;
  let last = 0;
  return {
    update(done: number, total: number, extra = '') {
      const now = Date.now();
      if (now - last < 100 && done < total) return;
      last = now;
      const w = 28;
      const filled = Math.round((done / total) * w);
      const line = `${label} [${'█'.repeat(filled)}${'░'.repeat(w - filled)}] ${done}/${total} ${extra}`;
      if (tty) process.stderr.write(`\r${line}\x1b[K`);
      else if (done === total || done % Math.max(1, Math.floor(total / 10)) === 0) process.stderr.write(`${line}\n`);
    },
    done() {
      if (tty) process.stderr.write('\n');
    },
  };
}

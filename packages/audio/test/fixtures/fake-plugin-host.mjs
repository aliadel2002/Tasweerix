// Minimal plugin host speaking the Tasweerix plugin-host protocol, for tests.
// "Plugins" are gains: params.gain is in dB; the reply echoes the header in stderr-free JSON.
const cmd = process.argv[2];
if (cmd === 'capabilities') {
  process.stdout.write(JSON.stringify({ protocol: 1, formats: ['vst3', 'clap'] }));
  process.exit(0);
}
if (cmd !== 'process') process.exit(2);
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const buf = Buffer.concat(chunks);
  const nl = buf.indexOf(10);
  const h = JSON.parse(buf.subarray(0, nl).toString('utf8'));
  if (!String(h.path).endsWith('gain.clap') && !String(h.path).endsWith('gain.vst3')) {
    process.stderr.write(`cannot load ${h.path}`);
    process.exit(1);
  }
  const body = buf.subarray(nl + 1);
  const samples = new Float32Array(h.frames * h.channels);
  new Uint8Array(samples.buffer).set(body.subarray(0, samples.byteLength));
  const g = Math.pow(10, (h.params.gain ?? 0) / 20);
  for (let i = 0; i < samples.length; i++) samples[i] *= g;
  process.stdout.write(JSON.stringify({ protocol: 1, channels: h.channels, frames: h.frames, sampleRate: h.sampleRate }) + '\n');
  process.stdout.write(Buffer.from(samples.buffer));
});

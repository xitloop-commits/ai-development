/** Repair the corrupt 2026-08-05 underlying tick gzips. Streaming decode per
 *  gzip member so member 1's valid PREFIX (up to the bad block) is kept, not
 *  lost like a sync gunzip would. Reads the .corrupt-bak original, merges both
 *  members, writes a clean single-member gzip. Idempotent (always reads .bak). */
import fs from 'fs';
import zlib from 'zlib';
import { Readable } from 'stream';

function decodeMember(slice) {
  return new Promise((resolve) => {
    const gz = zlib.createGunzip();
    let text = '';
    gz.on('data', (d) => { text += d.toString('utf8'); });
    gz.on('error', () => resolve(text));   // keep the valid prefix
    gz.on('end', () => resolve(text));
    Readable.from(slice).pipe(gz);
  });
}

for (const f of ['nifty50', 'banknifty']) {
  const path = `data/raw/2026-08-05/${f}_underlying_ticks.ndjson.gz`;
  const bak = path + '.corrupt-bak';
  const src = fs.existsSync(bak) ? bak : path;
  const buf = fs.readFileSync(src);
  const offs = [];
  for (let i = 0; i + 2 < buf.length; i++) if (buf[i] === 0x1f && buf[i + 1] === 0x8b && buf[i + 2] === 0x08) offs.push(i);
  const seen = new Set();
  const lines = [];
  for (const off of offs) {
    const text = await decodeMember(buf.subarray(off));
    for (const line of text.split('\n')) {
      if (line.length < 8) continue;
      const tm = /"recv_ts":\s*([0-9.]+)/.exec(line);
      const lm = /"ltp":\s*(-?[0-9.]+)/.exec(line);
      if (!tm || !lm || !(parseFloat(lm[1]) > 0)) continue;
      if (seen.has(tm[1])) continue;
      seen.add(tm[1]);
      lines.push([parseFloat(tm[1]), line]);
    }
  }
  lines.sort((a, b) => a[0] - b[0]);
  if (!fs.existsSync(bak)) fs.renameSync(path, bak);
  fs.writeFileSync(path, zlib.gzipSync(Buffer.from(lines.map((l) => l[1]).join('\n') + '\n', 'utf8')));
  const fmt = (s) => new Date(s * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`${f}: recovered ${lines.length} ticks (${fmt(lines[0][0])} → ${fmt(lines[lines.length-1][0])}) from ${offs.length} members`);
}

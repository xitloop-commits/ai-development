/**
 * Renders Font Awesome SVGs to white-on-transparent PNGs using resvg-js.
 * Outputs to startup/icons/<name>_<size>.png
 */
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir  = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dir, 'icons');
mkdirSync(outDir, { recursive: true });

const SIZES = [16, 32, 48, 256];

const SVGS = [
  'rocket', 'server', 'chart-line', 'building-columns', 'oil-can', 'fire', 'paper-plane'
];

for (const name of SVGS) {
  const svgPath = join(outDir, `${name}.svg`);
  let src;
  try {
    src = readFileSync(svgPath, 'utf8');
  } catch {
    console.error(`Missing SVG: ${svgPath}  (run make_icons.py first to download)`);
    process.exit(1);
  }

  // Force all fills to white so icon renders as white on transparent
  const whiteSvg = src
    .replace(/fill="[^"]*"/g, 'fill="white"')
    .replace(/<svg /, '<svg fill="white" ');

  for (const size of SIZES) {
    const resvg = new Resvg(whiteSvg, {
      fitTo: { mode: 'width', value: size },
      background: 'rgba(0,0,0,0)',
    });
    const pngData = resvg.render().asPng();
    const outPath = join(outDir, `${name}_${size}.png`);
    writeFileSync(outPath, pngData);
  }
  console.log(`  Rendered: ${name}`);
}
console.log('Done.');

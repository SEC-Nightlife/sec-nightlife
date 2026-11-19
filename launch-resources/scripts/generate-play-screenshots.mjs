#!/usr/bin/env node
/**
 * Build Google Play phone + tablet screenshots from App Store assets.
 *
 * Outputs (max 8 recommended for upload; all sources exported):
 *   launch-resources/play-store/phone-screenshots/          1080x1920 (9:16)
 *   launch-resources/play-store/tablet-7-inch-screenshots/  1200x1920 (9:16)
 *   launch-resources/play-store/tablet-10-inch-screenshots/ 1600x2560 (9:16)
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appStorePhone = join(root, 'app-store', 'screenshots');
const appStoreIpad = join(root, 'app-store', 'ipad-13-screenshots');
const playStore = join(root, 'play-store');

const OUT = {
  phone: { dir: join(playStore, 'phone-screenshots'), w: 1080, h: 1920 },
  tablet7: { dir: join(playStore, 'tablet-7-inch-screenshots'), w: 1200, h: 1920 },
  tablet10: { dir: join(playStore, 'tablet-10-inch-screenshots'), w: 1600, h: 2560 },
};

function listPngs(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => extname(f).toLowerCase() === '.png')
      .sort();
  } catch {
    return [];
  }
}

const py = `
from PIL import Image
from pathlib import Path
import sys, json

jobs = json.loads(sys.argv[1])

def center_crop_to_aspect(im, tw, th):
    target_aspect = tw / th
    w, h = im.size
    src_aspect = w / h
    if abs(src_aspect - target_aspect) < 1e-6:
        cropped = im
    elif src_aspect > target_aspect:
        # too wide → crop left/right
        new_w = int(round(h * target_aspect))
        left = (w - new_w) // 2
        cropped = im.crop((left, 0, left + new_w, h))
    else:
        # too tall → crop top/bottom
        new_h = int(round(w / target_aspect))
        top = (h - new_h) // 2
        cropped = im.crop((0, top, w, top + new_h))
    return cropped.resize((tw, th), Image.Resampling.LANCZOS)

for job in jobs:
    src = Path(job['src'])
    dst = Path(job['dst'])
    dst.parent.mkdir(parents=True, exist_ok=True)
    im = Image.open(src).convert('RGB')
    out = center_crop_to_aspect(im, job['w'], job['h'])
    out.save(dst, format='PNG', optimize=True)
    print(f"{dst.name}: {out.size[0]}x{out.size[1]} <- {src.name} ({im.size[0]}x{im.size[1]})")
`;

const phoneSources = listPngs(appStorePhone);
const ipadSources = listPngs(appStoreIpad);

if (!phoneSources.length) {
  console.error('No PNGs in app-store/screenshots');
  process.exit(1);
}

const jobs = [];

for (const name of phoneSources) {
  jobs.push({
    src: join(appStorePhone, name),
    dst: join(OUT.phone.dir, name),
    w: OUT.phone.w,
    h: OUT.phone.h,
  });
}

// Prefer iPad sources for tablets; fall back to phone assets
const tabletNames = ipadSources.length ? ipadSources : phoneSources;
const tabletSrcDir = ipadSources.length ? appStoreIpad : appStorePhone;

for (const name of tabletNames) {
  const src = join(tabletSrcDir, name);
  jobs.push({ src, dst: join(OUT.tablet7.dir, name), w: OUT.tablet7.w, h: OUT.tablet7.h });
  jobs.push({ src, dst: join(OUT.tablet10.dir, name), w: OUT.tablet10.w, h: OUT.tablet10.h });
}

for (const d of Object.values(OUT)) mkdirSync(d.dir, { recursive: true });

execFileSync('python', ['-c', py, JSON.stringify(jobs)], { stdio: 'inherit' });

const readme = `# Play Store screenshots (ready to upload)

Generated from App Store assets. Aspect ratio **9:16** (Play requirement).

## Folders

| Folder | Size | Play Console field | Max upload |
|--------|------|--------------------|------------|
| [\`phone-screenshots/\`](phone-screenshots/) | **1080×1920** | Phone screenshots | 2–8 |
| [\`tablet-7-inch-screenshots/\`](tablet-7-inch-screenshots/) | **1200×1920** | 7-inch tablet | up to 8 |
| [\`tablet-10-inch-screenshots/\`](tablet-10-inch-screenshots/) | **1600×2560** | 10-inch tablet | up to 8 |

Source:
- Phone ← \`app-store/screenshots/\` (1284×2778), center-cropped to 9:16
- Tablets ← \`app-store/ipad-13-screenshots/\` (2064×2752) when present, else phone sources

## Recommended upload order (first 8)

1. \`01-home.png\`
2. \`02-profile.png\`
3. \`06-host-dashboard.png\`
4. \`01-dashboard.png\` (or \`01-venue-dashboard.png\`)
5. \`02-analytics.png\`
6. \`03-bookings.png\`
7. \`04-menu-food.png\`
8. \`03-messages.png\`

Optional extras in the same folders: friends, notifications, guest-home, manage-tables, day-listings, hero-brand.

## Regenerate

\`\`\`bash
node launch-resources/scripts/generate-play-screenshots.mjs
\`\`\`
`;

writeFileSync(join(playStore, 'SCREENSHOTS_README.md'), readme);
console.log('\nWrote', join(playStore, 'SCREENSHOTS_README.md'));
console.log('Phone:', OUT.phone.dir);
console.log('Tablet 7":', OUT.tablet7.dir);
console.log('Tablet 10":', OUT.tablet10.dir);

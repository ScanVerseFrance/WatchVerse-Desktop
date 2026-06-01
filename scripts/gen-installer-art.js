// Generate the BMP assets the NSIS installer requires for branded look:
//   • assets/installerHeader.bmp     150 × 57   — top-of-window banner
//   • assets/installerSidebar.bmp    164 × 314  — left side of welcome/finish pages
//   • assets/uninstallerSidebar.bmp  164 × 314  — same for the uninstaller welcome
//
// Built from assets/icon.png via sharp + raw pixel composition. Pure
// gradient + centred icon — no Photoshop in the loop. Re-run this any
// time the brand colours or icon change.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');

const ACCENT_RGB = { r: 230, g: 57,  b: 70  }; // #e63946 — WatchVerse red
const BG_DARK    = { r: 10,  g: 10,  b: 15  }; // #0a0a0f — page background
const BG_MID     = { r: 24,  g: 24,  b: 31  }; // #18181f — surface

async function makeSidebar(out, width = 164, height = 314) {
  // Vertical gradient from BG_DARK at top to a tinted red at bottom,
  // with the icon centered roughly in the upper third.
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    // ease-out so the red bloom feels softer.
    const eased = Math.pow(t, 1.4);
    const r = Math.round(BG_DARK.r + (ACCENT_RGB.r * 0.35 - BG_DARK.r) * eased);
    const g = Math.round(BG_DARK.g + (ACCENT_RGB.g * 0.20 - BG_DARK.g) * eased);
    const b = Math.round(BG_DARK.b + (ACCENT_RGB.b * 0.45 - BG_DARK.b) * eased);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      buf[i]     = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
  // Composite the icon at ~96 px, centred horizontally, ~30 % from the top.
  const iconSize = Math.round(width * 0.55);
  const iconBuf = await sharp(ICON)
    .resize(iconSize, iconSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const iconLeft = Math.round((width - iconSize) / 2);
  const iconTop  = Math.round(height * 0.18);

  // Sharp can't output BMP directly; composite to a raw RGB Buffer then
  // hand-encode to 24-bit BMP (the format NSIS demands).
  const composed = await sharp(buf, { raw: { width, height, channels: 4 } })
    .composite([{ input: iconBuf, top: iconTop, left: iconLeft }])
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: false });
  fs.writeFileSync(out, encodeBmp(composed, width, height));
  console.log('  ✓', path.basename(out), `${width}×${height}`);
}

async function makeHeader(out, width = 150, height = 57) {
  // Horizontal gradient: solid #18181f on the right (where NSIS draws
  // its title text in white) → small purple accent panel on the left.
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1);
      // Sharp purple glow for the leftmost 35 %, fade to neutral after.
      const left = t < 0.35 ? (1 - t / 0.35) : 0;
      const r = Math.round(BG_MID.r + (ACCENT_RGB.r - BG_MID.r) * left * 0.45);
      const g = Math.round(BG_MID.g + (ACCENT_RGB.g - BG_MID.g) * left * 0.30);
      const b = Math.round(BG_MID.b + (ACCENT_RGB.b - BG_MID.b) * left * 0.55);
      const i = (y * width + x) * 4;
      buf[i]     = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
  // Tiny icon (~40 px) in the left margin
  const iconSize = Math.min(40, height - 8);
  const iconBuf = await sharp(ICON)
    .resize(iconSize, iconSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const composed = await sharp(buf, { raw: { width, height, channels: 4 } })
    .composite([{ input: iconBuf, top: Math.round((height - iconSize) / 2), left: 6 }])
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: false });
  fs.writeFileSync(out, encodeBmp(composed, width, height));
  console.log('  ✓', path.basename(out), `${width}×${height}`);
}

/**
 * Encode a raw RGB pixel buffer (top-down, R-G-B order) into a 24-bit BMP.
 * BMP format details:
 *   • 14 B BITMAPFILEHEADER
 *   • 40 B BITMAPINFOHEADER
 *   • pixel rows are stored BOTTOM-UP, each row padded to a 4-byte multiple,
 *     and pixels are B-G-R (not R-G-B).
 */
function encodeBmp(rgb, width, height) {
  const rowStride = width * 3;
  const padded   = (rowStride + 3) & ~3;          // round up to multiple of 4
  const pad      = padded - rowStride;
  const pixelSize = padded * height;
  const fileSize  = 14 + 40 + pixelSize;

  const buf = Buffer.alloc(fileSize);
  // BITMAPFILEHEADER
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0,        6); // reserved
  buf.writeUInt32LE(54,      10); // pixel data offset
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40,        14); // header size
  buf.writeInt32LE(width,      18);
  buf.writeInt32LE(height,     22); // positive = bottom-up
  buf.writeUInt16LE(1,         26); // planes
  buf.writeUInt16LE(24,        28); // bits per pixel
  buf.writeUInt32LE(0,         30); // BI_RGB (no compression)
  buf.writeUInt32LE(pixelSize, 34);
  buf.writeUInt32LE(2835,      38); // ~72 DPI (pixels/m)
  buf.writeUInt32LE(2835,      42);
  buf.writeUInt32LE(0,         46); // colours used
  buf.writeUInt32LE(0,         50); // important colours

  // Pixel data: bottom-up, B-G-R, row padding to 4-byte boundary.
  let off = 54;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      buf[off++] = rgb[src + 2]; // B
      buf[off++] = rgb[src + 1]; // G
      buf[off++] = rgb[src];     // R
    }
    for (let p = 0; p < pad; p++) buf[off++] = 0;
  }
  return buf;
}

async function makeIco(out) {
  // Multi-resolution ICO. Sharp doesn't write ICO, so we hand-pack one
  // ourselves: header + per-image directory entries + concatenated PNG
  // payloads. Every modern Windows build accepts PNG-payload ICO.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map(s =>
    sharp(ICON)
      .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer()
  ));
  const headerSize = 6 + 16 * sizes.length;
  let totalSize = headerSize;
  for (const p of pngs) totalSize += p.length;
  const buf = Buffer.alloc(totalSize);
  buf.writeUInt16LE(0, 0);              // reserved
  buf.writeUInt16LE(1, 2);              // type 1 = icon
  buf.writeUInt16LE(sizes.length, 4);   // image count
  let dirOff = 6;
  let pixelOff = headerSize;
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    const png = pngs[i];
    // 256 px is encoded as 0 in the BMP-style width/height fields.
    buf.writeUInt8(s === 256 ? 0 : s, dirOff);
    buf.writeUInt8(s === 256 ? 0 : s, dirOff + 1);
    buf.writeUInt8(0, dirOff + 2);                 // colour count
    buf.writeUInt8(0, dirOff + 3);                 // reserved
    buf.writeUInt16LE(1, dirOff + 4);              // colour planes
    buf.writeUInt16LE(32, dirOff + 6);             // bit depth
    buf.writeUInt32LE(png.length, dirOff + 8);     // image size
    buf.writeUInt32LE(pixelOff, dirOff + 12);      // image offset
    png.copy(buf, pixelOff);
    pixelOff += png.length;
    dirOff   += 16;
  }
  fs.writeFileSync(out, buf);
  console.log('  ✓', path.basename(out), `(${sizes.join('/')} px)`);
}

async function main() {
  if (!fs.existsSync(ICON)) {
    console.error('[gen-installer-art] missing', ICON);
    process.exit(1);
  }
  const outDir = path.join(ROOT, 'assets');
  console.log('[gen-installer-art] writing assets:');
  await makeSidebar(path.join(outDir, 'installerSidebar.bmp'));
  await makeSidebar(path.join(outDir, 'uninstallerSidebar.bmp'));
  await makeHeader (path.join(outDir, 'installerHeader.bmp'));
  await makeIco    (path.join(outDir, 'installer-icon.ico'));
  console.log('[gen-installer-art] done.');
}

main().catch(err => {
  console.error('[gen-installer-art] fatal', err);
  process.exit(1);
});

import { createCanvas } from 'canvas';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUT = resolve(process.cwd(), 'public');
mkdirSync(OUT, { recursive: true });

function drawIcon(ctx, size) {
  const s = size;
  const px = v => (v / 1024) * s;

  const bg = ctx.createRadialGradient(s * 0.5, s * 0.38, 0, s * 0.5, s * 0.38, s * 0.65);
  bg.addColorStop(0, '#1c2230');
  bg.addColorStop(1, '#0b0d11');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, s, s);

  ctx.save();
  ctx.translate(0, px(40));

  const socketGrad = ctx.createLinearGradient(0, px(240), 0, px(820));
  socketGrad.addColorStop(0, '#5a6474');
  socketGrad.addColorStop(1, '#1d2230');
  ctx.fillStyle = socketGrad;
  ctx.strokeStyle = '#6a7282';
  ctx.lineWidth = px(10);
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(px(232), px(380));
  ctx.lineTo(px(372), px(240));
  ctx.lineTo(px(652), px(240));
  ctx.lineTo(px(792), px(380));
  ctx.lineTo(px(792), px(820));
  ctx.lineTo(px(232), px(820));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#07090c';
  const pin = (x, y, w, h) => {
    const r = px(4);
    const x0 = px(x), y0 = px(y), w0 = px(w), h0 = px(h);
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.lineTo(x0 + w0 - r, y0);
    ctx.quadraticCurveTo(x0 + w0, y0, x0 + w0, y0 + r);
    ctx.lineTo(x0 + w0, y0 + h0 - r);
    ctx.quadraticCurveTo(x0 + w0, y0 + h0, x0 + w0 - r, y0 + h0);
    ctx.lineTo(x0 + r, y0 + h0);
    ctx.quadraticCurveTo(x0, y0 + h0, x0, y0 + h0 - r);
    ctx.lineTo(x0, y0 + r);
    ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
    ctx.closePath();
    ctx.fill();
  };
  pin(344, 500, 128, 34);
  pin(552, 500, 128, 34);
  pin(448, 716, 128, 34);
  ctx.restore();

  const glow = ctx.createRadialGradient(s * 0.5, px(150), 0, s * 0.5, px(150), px(96));
  glow.addColorStop(0, 'rgba(34,197,94,1)');
  glow.addColorStop(0.6, 'rgba(34,197,94,0.55)');
  glow.addColorStop(1, 'rgba(34,197,94,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(s * 0.5, px(150), px(96), 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#22c55e';
  ctx.beginPath();
  ctx.arc(s * 0.5, px(150), px(36), 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#a7f3d0';
  ctx.beginPath();
  ctx.arc(s * 0.5 - px(10), px(140), px(10), 0, Math.PI * 2);
  ctx.fill();
}

function writeIcon(size, name) {
  const c = createCanvas(size, size);
  drawIcon(c.getContext('2d'), size);
  const path = resolve(OUT, name);
  writeFileSync(path, c.toBuffer('image/png'));
  console.log(`  ${name} (${size}×${size})`);
}

function writeOg() {
  const W = 1200, H = 630;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');

  const bg = ctx.createRadialGradient(W * 0.5, H * 0.3, 0, W * 0.5, H * 0.3, W * 0.6);
  bg.addColorStop(0, '#1c2230');
  bg.addColorStop(1, '#0b0d11');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const iconSize = 340;
  const iconX = (W - iconSize) / 2;
  const iconY = 90;
  ctx.save();
  ctx.translate(iconX, iconY);
  const sub = createCanvas(iconSize, iconSize);
  drawIcon(sub.getContext('2d'), iconSize);
  ctx.drawImage(sub, 0, 0);
  ctx.restore();

  ctx.fillStyle = '#e5e7eb';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 52px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('PDU Controller', W / 2, 490);

  ctx.fillStyle = '#6ee7b7';
  ctx.font = '400 26px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('ATEN PE8208G · 8-outlet rack PDU via SNMP', W / 2, 545);

  writeFileSync(resolve(OUT, 'og-image.png'), c.toBuffer('image/png'));
  console.log(`  og-image.png (${W}×${H})`);
}

console.log('Generating icons →', OUT);
writeIcon(32, 'favicon-32.png');
writeIcon(180, 'apple-touch-icon.png');
writeIcon(192, 'icon-192.png');
writeIcon(512, 'icon-512.png');
writeOg();
console.log('Done.');

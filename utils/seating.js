// utils/seating.js
const Jimp = require('jimp');
const { createCanvas, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const logger = require('./logger');
const config = require('../config/charts.config.json');

const cache = new Map();
const CACHE_MAX_SIZE = 20;

function ensureDirSync(p) {
  if (!fsSync.existsSync(p)) fsSync.mkdirSync(p, { recursive: true });
}

// Names are drawn with node-canvas (anti-aliased text and rotation, real TTF font),
// then composited onto the Jimp map. Open Sans is bundled in fonts/ (OFL licence).
const NAME_FONT_FAMILY = 'Open Sans';
const FONT_FILES = [
  { file: 'OpenSans-Regular.ttf', weight: 'normal' },
  { file: 'OpenSans-Bold.ttf', weight: 'bold' },
];
for (const { file, weight } of FONT_FILES) {
  try {
    registerFont(path.join(__dirname, '..', 'fonts', file), { family: NAME_FONT_FAMILY, weight });
  } catch (e) {
    logger.warn(`Seating: could not load font ${file}, names fall back to sans-serif: ${e.message}`);
  }
}

function nameStyle() {
  const s = config.seating || {};
  const size = Number(s.nameFontSize) || 15;
  return {
    font: `${s.nameFontWeight || 'bold'} ${size}px "${NAME_FONT_FAMILY}", sans-serif`,
    color: s.nameColor || '#000000',
  };
}

// Margin around the text so anti-aliased glyph edges are never clipped
const NAME_PAD_PX = 1;

/**
 * Draw a (rotated) name. Returns the image plus the unrotated text box size;
 * the text is centred in the image, which is what the pin math relies on.
 */
async function renderName(nick, angle, maxWidth) {
  const style = nameStyle();
  const measure = createCanvas(1, 1).getContext('2d');
  measure.font = style.font;

  let text = nick;
  if (maxWidth > 0) {
    while (text.length > 1 && measure.measureText(text).width > maxWidth) text = text.slice(0, -1);
    if (text !== nick) text = text.replace(/.?.?$/, '..');
  }
  // Height from fixed glyphs so every name gets the same box, whatever its letters
  const ref = measure.measureText('Hgjy');
  const pad = NAME_PAD_PX;
  const textWidth = Math.ceil((maxWidth > 0 ? maxWidth : measure.measureText(text).width) + pad * 2);
  const textHeight = Math.ceil(ref.actualBoundingBoxAscent + ref.actualBoundingBoxDescent + pad * 2);

  const rad = -angle * Math.PI / 180; // canvas rotates clockwise for positive angles
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const rw = Math.max(1, Math.ceil(textWidth * c + textHeight * s));
  const rh = Math.max(1, Math.ceil(textWidth * s + textHeight * c));

  const canvas = createCanvas(rw, rh);
  const ctx = canvas.getContext('2d');
  ctx.translate(rw / 2, rh / 2);
  ctx.rotate(rad);
  ctx.font = style.font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const x = -textWidth / 2 + pad;
  const y = -textHeight / 2 + pad + ref.actualBoundingBoxAscent;
  ctx.fillStyle = style.color;
  ctx.fillText(text, x, y);

  return { textImg: await Jimp.read(canvas.toBuffer('image/png')), textWidth, textHeight };
}

async function loadChartById(chartId) {
  const chartsDir = config.chartsDir || './charts';
  ensureDirSync(chartsDir);

  const tryPaths = [
    path.join(chartsDir, chartId, 'chart.json'),
    path.join(chartsDir, `${chartId}.json`)
  ];
  let lastErr;

  for (const p of tryPaths) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const json = JSON.parse(raw);
      validateChart(json);
      const root = path.dirname(p);
      return { chart: json, root };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Seating chart "${chartId}" not found or invalid: ${lastErr?.message}`);
}

function validateChart(j) {
  if (!j || j.version !== 2) throw new Error('Unsupported chart version (need version=2)');
  if (!Array.isArray(j.seats)) throw new Error('chart.seats must be an array');
  for (const s of j.seats) {
    const idOk = typeof s.id === 'number' || (typeof s.id === 'string' && s.id.trim() !== '');
    if (!idOk || typeof s.x !== 'number' || typeof s.y !== 'number' || !s.shape) {
      throw new Error('Seat missing id/x/y/shape');
    }
  }
}

function seatBBox(seat) {
  if (seat.shape === 'rect') {
    const w = seat.w ?? 0, h = seat.h ?? 0;
    return { left: seat.x - w/2, right: seat.x + w/2, top: seat.y - h/2, bottom: seat.y + h/2 };
  }
  const r = seat.r ?? 0;
  return { left: seat.x - r, right: seat.x + r, top: seat.y - r, bottom: seat.y + r };
}

async function drawSeat(image, seat, colorRGBA) {
  if (seat.shape === 'rect') {
    const w = seat.w ?? 0, h = seat.h ?? 0;
    const rect = await new Jimp(w, h, colorRGBA);
    const rotation = (seat.rotation || 0);
    if (rotation) rect.rotate(rotation, false);
    const ox = Math.round(seat.x - rect.bitmap.width / 2);
    const oy = Math.round(seat.y - rect.bitmap.height / 2);
    image.composite(rect, ox, oy);
  } else {
    const r = seat.r ?? 0;
    const diameter = Math.max(1, Math.round(r * 2));
    const circleImg = await new Jimp(diameter, diameter, 0x00000000);
    const [cx, cy] = [r, r];
    const rgba = Jimp.cssColorToHex(colorRGBA);

    circleImg.scan(0, 0, diameter, diameter, function(x, y, idx) {
      const dx = x - cx, dy = y - cy;
      if (dx*dx + dy*dy <= r*r) {
        this.bitmap.data[idx+0] = (rgba >> 24) & 0xFF;
        this.bitmap.data[idx+1] = (rgba >> 16) & 0xFF;
        this.bitmap.data[idx+2] = (rgba >> 8) & 0xFF;
        this.bitmap.data[idx+3] = (rgba) & 0xFF;
      }
    });

    const ox = Math.round(seat.x - r);
    const oy = Math.round(seat.y - r);
    image.composite(circleImg, ox, oy);
  }
}

function truncateName(nick, maxChars) {
  if (!maxChars || nick.length <= maxChars) return nick;
  return nick.substring(0, Math.max(0, maxChars - 2)) + '..';
}

// Debug helpers
function drawCross(img, x, y, size = 6, color = 0xff0000ff) {
  for (let i = -size; i <= size; i++) {
    const px = x + i, py = y;
    if (px >= 0 && px < img.bitmap.width && py >= 0 && py < img.bitmap.height) img.setPixelColor(color, px, py);
  }
  for (let i = -size; i <= size; i++) {
    const px = x, py = y + i;
    if (px >= 0 && px < img.bitmap.width && py >= 0 && py < img.bitmap.height) img.setPixelColor(color, px, py);
  }
}
function drawRectOutline(img, x, y, w, h, color = 0xffffffff) {
  for (let i = 0; i < w; i++) {
    if (y >= 0 && y < img.bitmap.height) img.setPixelColor(color, x + i, y);
    if (y + h - 1 >= 0 && y + h - 1 < img.bitmap.height) img.setPixelColor(color, x + i, y + h - 1);
  }
  for (let j = 0; j < h; j++) {
    if (x >= 0 && x < img.bitmap.width) img.setPixelColor(color, x, y + j);
    if (x + w - 1 >= 0 && x + w - 1 < img.bitmap.width) img.setPixelColor(color, x + w - 1, y + j);
  }
}

async function renderMapForEvent(eventRow, occupied, pendingColor, occupiedColor) {
  const chartId = eventRow.chartId || (config.seating?.defaultChartId) || 'default';
  const cacheKey = `chart:${chartId}`;

  if (!cache.has(cacheKey)) {
    const loaded = await loadChartById(chartId);
    if (cache.size >= CACHE_MAX_SIZE) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, loaded);
  }
  const { chart, root } = cache.get(cacheKey);

  const basePath = eventRow.baseImagePath
    ? (path.isAbsolute(eventRow.baseImagePath) ? eventRow.baseImagePath : path.join(process.cwd(), eventRow.baseImagePath))
    : path.join(root, chart.image?.path || 'SeatingMap.png');

  const image = await Jimp.read(basePath);

  const byId = new Map();
  for (const s of chart.seats) {
    byId.set(String(s.id), s);
    byId.set(Number(s.id), s);
  }

  const invertRotation = !!config.seating?.invertNameRotation;
  const debug          = !!config.seating?.debug;

  for (const occ of occupied) {
    const seatKey = occ.seatId ?? occ.seat;
    const seat = byId.get(seatKey);
    if (!seat) continue;

    // 1) Draw seat overlay color
    await drawSeat(image, seat, occ.hasPaid ? occupiedColor : pendingColor);

    // 2) Name rendering (rotation + edge/corner pinning)
    const nameAnchor   = String(seat.nameAnchor || 'center').toLowerCase(); // left|right|top|bottom|center|custom
    const nameOffset   = seat.nameOffset || { x: 0, y: 0 };
    const nameRotation = seat.nameRotation || 0;
    const nameMaxWidth = typeof seat.nameMaxWidth === 'number' ? seat.nameMaxWidth : 0;

    const nick = truncateName(occ.nickname, config.seating?.nameMaxChars ?? 12);

    // Positive angle = counter-clockwise on the image (Jimp's convention, kept for the pin math below)
    const angle = nameRotation ? (invertRotation ? -nameRotation : nameRotation) : 0;
    const { textImg, textWidth, textHeight } = await renderName(nick, angle, nameMaxWidth);

    // Rotated dimensions
    const rw = textImg.bitmap.width;
    const rh = textImg.bitmap.height;

    if (debug) {
      logger.info(`[seating] seat=${seat.id} anchor=${nameAnchor} rotation=${angle}`);
    }

    // Seat bbox + offsets (with intuitive semantics)
    const bbox = seatBBox(seat);
    const offX = nameOffset?.x ?? 0;
    const offY = nameOffset?.y ?? 0;

    // Target anchor point (where the chosen pin should land)
    let targetX, targetY;
    switch (nameAnchor) {
      case 'left':
        targetX = bbox.left - Math.abs(offX);
        targetY = seat.y + offY;
        if (debug) drawCross(image, Math.round(targetX), Math.round(targetY), 5, 0x00ff00ff); // green
        break;
      case 'right':
        targetX = bbox.right + Math.abs(offX);
        targetY = seat.y + offY;
        if (debug) drawCross(image, Math.round(targetX), Math.round(targetY), 5, 0x0000ffff); // blue
        break;
      case 'top':
        targetX = seat.x + offX;
        targetY = bbox.top - Math.abs(offY);
        if (debug) drawCross(image, Math.round(targetX), Math.round(targetY), 5, 0x88ffffff);
        break;
      case 'bottom':
        targetX = seat.x + offX;
        targetY = bbox.bottom + Math.abs(offY);
        if (debug) drawCross(image, Math.round(targetX), Math.round(targetY), 5, 0x8844ffff);
        break;
      case 'center':
        targetX = seat.x + offX;
        targetY = seat.y + offY;
        if (debug) drawCross(image, Math.round(targetX), Math.round(targetY), 5, 0xffff00ff); // yellow
        break;
      case 'custom':
      default:
        targetX = seat.x + offX;
        targetY = seat.y + offY;
        if (debug) drawCross(image, Math.round(targetX), Math.round(targetY), 5, 0xff00ffff); // magenta
        break;
    }

    // Edge/corner pinning:
    // - left   => pin RIGHT edge (closest to seat)
    // - right  => pin LEFT  edge
    // - top    => pin the bottommost corner of the rotated text (nearest the seat)
    // - bottom => pin the topmost corner of the rotated text (nearest the seat)
    let pinX, pinY;
    const nudgePx = Number.isFinite(config.seating?.anchorNudgePx)
      ? config.seating.anchorNudgePx
      : Math.round(textHeight * (config.seating?.anchorNudgePct ?? 0.2));

    const pinAsRightEdge = (nameAnchor === 'left');  // right edge pinned
    const pinAsLeftEdge  = (nameAnchor === 'right'); // left edge pinned

    if (nameAnchor === 'top' || nameAnchor === 'bottom') {
      // Pin the point of the (rotated) text nearest the seat: its topmost corner
      // when below, its bottommost corner when above (two corners tie → their midpoint).
      const phi = -angle * Math.PI / 180; // visual rotation, clockwise (Jimp rotates CCW)
      const c = Math.cos(phi), s = Math.sin(phi);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
        const x = sx * textWidth / 2, y = sy * textHeight / 2;
        return { x: x * c - y * s, y: x * s + y * c };
      });
      const ys = corners.map(p => p.y);
      const edgeY = nameAnchor === 'bottom' ? Math.min(...ys) : Math.max(...ys);
      const near = corners.filter(p => Math.abs(p.y - edgeY) < 0.5);
      pinX = rw / 2 + near.reduce((sum, p) => sum + p.x, 0) / near.length;
      pinY = rh / 2 + edgeY;
    } else if (pinAsRightEdge) {
      if (angle > 0) {
        // right edge higher for +angle → TOP-RIGHT, nudge down
        pinX = rw;  pinY = 0 + nudgePx;
      } else if (angle < 0) {
        // right edge lower for -angle → BOTTOM-RIGHT, nudge up
        pinX = rw;  pinY = rh - nudgePx;
      } else {
        // no rotation: right-center
        pinX = rw;  pinY = rh / 2;
      }
    } else if (pinAsLeftEdge) {
      if (angle > 0) {
        // left edge lower for +angle → BOTTOM-LEFT, nudge up
        pinX = 0;   pinY = rh - nudgePx;
      } else if (angle < 0) {
        // left edge higher for -angle → TOP-LEFT, nudge down
        pinX = 0;   pinY = 0 + nudgePx;
      } else {
        // no rotation: left-center
        pinX = 0;   pinY = rh / 2;
      }
    } else if (nameAnchor === 'center') {
      pinX = rw / 2; pinY = rh / 2;
    } else {
      // custom → top-left at target
      pinX = 0; pinY = 0;
    }

    // Place the rotated bitmap so that its chosen pin lands on the target
    const placeX = Math.round(targetX - pinX);
    const placeY = Math.round(targetY - pinY);

    if (debug) {
      drawRectOutline(image, placeX, placeY, rw, rh, 0xffffffff); // outline text box
      drawCross(image, Math.round(targetX), Math.round(targetY), 4, 0xffaa00ff); // orange pin
    }

    image.composite(textImg, placeX, placeY);
  }

  // ✅ return the rendered PNG buffer
  return await image.getBufferAsync(Jimp.MIME_PNG);
}

function invalidateChartCache(chartId) {
  cache.delete(`chart:${chartId}`);
}

module.exports = {
  loadChartById,
  validateChart,
  renderMapForEvent,
  ensureDirSync,
  invalidateChartCache
};

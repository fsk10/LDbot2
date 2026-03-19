// utils/seating.js
const Jimp = require('jimp');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const logger = require('./logger');
const config = require('../config/charts.config.json');

const cache = new Map();

function ensureDirSync(p) {
  if (!fsSync.existsSync(p)) fsSync.mkdirSync(p, { recursive: true });
}

function resolveJimpFont(fontKey) {
  const key = String(fontKey || 'FONT_SANS_16_BLACK');
  return Jimp[key] || Jimp.FONT_SANS_16_BLACK;
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
    cache.set(cacheKey, loaded);
  }
  const { chart, root } = cache.get(cacheKey);

  const basePath = eventRow.baseImagePath
    ? (path.isAbsolute(eventRow.baseImagePath) ? eventRow.baseImagePath : path.join(process.cwd(), eventRow.baseImagePath))
    : path.join(root, chart.image?.path || 'SeatingMap.png');

  const image = await Jimp.read(basePath);
  const fontConst = resolveJimpFont(config.seating?.font);
  const font = await Jimp.loadFont(fontConst);

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

    // Measure unrotated text
    const textWidth  = nameMaxWidth > 0 ? nameMaxWidth : Jimp.measureText(font, nick);
    const textHeight = Jimp.measureTextHeight(font, nick, textWidth || 1);

    // Render unrotated text surface
    let textImg = await new Jimp(Math.max(1, textWidth), Math.max(1, textHeight), 0x00000000);
    textImg.print(
      font,
      0, 0,
      { text: nick, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT, alignmentY: Jimp.VERTICAL_ALIGN_TOP },
      textWidth,
      textHeight
    );

    // Rotate around center (auto-resize)
    const angle = nameRotation ? (invertRotation ? -nameRotation : nameRotation) : 0;
    if (angle) textImg = textImg.rotate(angle, true);

    // Rotated dimensions
    const rw = textImg.bitmap.width;
    const rh = textImg.bitmap.height;

    // mall horizontal nudge to visually center names for top/bottom anchors
    const seatW = (seat.shape === 'rect')
      ? (seat.w ?? 0)
      : ((seat.r ?? 0) * 2);

    const edgeXNudgePx = Number.isFinite(config?.seating?.anchorXNudgePx)
      ? config.seating.anchorXNudgePx
      : Math.round(seatW * (Number(config?.seating?.anchorXNudgePct) || 0.18));

    if (debug) {
      logger.info(`[seating] seat=${seat.id} anchor=${nameAnchor} nudgePx=${edgeXNudgePx} seatW=${seatW}`);
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
        targetX = seat.x + offX - edgeXNudgePx;
        targetY = bbox.top - Math.abs(offY);
        if (debug) drawCross(image, Math.round(targetX), Math.round(targetY), 5, 0x88ffffff);
        break;
      case 'bottom':
        targetX = seat.x + offX + edgeXNudgePx;
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
    // - top    => pin LEFT  edge  (same edge as "right")
    // - bottom => pin RIGHT edge  (same edge as "left")
    let pinX, pinY;
    const nudgePx = Number.isFinite(config.seating?.anchorNudgePx)
      ? config.seating.anchorNudgePx
      : Math.round(textHeight * (config.seating?.anchorNudgePct ?? 0.2));

    const pinAsRightEdge = (nameAnchor === 'left' || nameAnchor === 'bottom'); // right edge pinned
    const pinAsLeftEdge  = (nameAnchor === 'right' || nameAnchor === 'top');   // left edge pinned

    if (pinAsRightEdge) {
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
  renderMapForEvent,
  ensureDirSync,
  resolveJimpFont,
  invalidateChartCache
};

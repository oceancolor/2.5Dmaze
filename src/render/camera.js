// 摄像机（02 §2.4）：跟随玩家（指数阻尼），三档缩放 cfg.render.zoomLevels；拖拽可临时脱离跟随，玩家一动或按 F 归位。
// 只存世界坐标（iso 1× 像素）的视口中心与 zoom；世界 → 屏幕的换算在 renderer 里做（格 → 世界只走 iso.js）。

import { worldBounds } from './iso.js';

export function createCamera({ zoomLevels, size, tau = 90 }) {
  const wb = worldBounds(size);
  let zi = 0;
  let x = 0;
  let y = 0;
  let tx = 0;
  let ty = 0;
  let snapped = false;
  let free = false;

  const clampX = (v) => Math.min(wb.maxX, Math.max(wb.minX, v));
  const clampY = (v) => Math.min(wb.maxY, Math.max(wb.minY, v));

  return {
    get x() { return x; },
    get y() { return y; },
    get zoom() { return zoomLevels[zi]; },
    get zoomIndex() { return zi; },
    get free() { return free; },
    /** 最小档 = 全图档（overview 位图）。 */
    get overview() { return zi === zoomLevels.length - 1; },

    /** 跟随目标（世界坐标）。free 时只记下目标，不动镜头。 */
    follow(wx, wy) {
      tx = clampX(wx);
      ty = clampY(wy);
      if (!snapped) {
        x = tx;
        y = ty;
        snapped = true;
      }
    },
    /** 每帧推进阻尼。viewW/viewH 为 CSS 像素视口；全图档若整图放得下就居中不动。 */
    update(dt, viewW, viewH) {
      const z = zoomLevels[zi];
      if (this.overview && wb.width * z <= viewW && wb.height * z <= viewH) {
        x = (wb.minX + wb.maxX) / 2;
        y = (wb.minY + wb.maxY) / 2;
        return;
      }
      if (free) return;
      const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
      x += (tx - x) * k;
      y += (ty - y) * k;
    },
    /** 屏幕像素拖拽（CSS 像素）。 */
    pan(dx, dy) {
      const z = zoomLevels[zi];
      free = true;
      x = clampX(x - dx / z);
      y = clampY(y - dy / z);
    },
    recenter() {
      free = false;
    },
    setZoomIndex(i) {
      zi = Math.min(zoomLevels.length - 1, Math.max(0, i));
    },
    zoomBy(step) {
      this.setZoomIndex(zi + step);
    },
  };
}

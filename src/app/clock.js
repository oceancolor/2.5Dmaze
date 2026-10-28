// 全项目唯一允许读墙钟的文件（SPEC §12）。内核 / AI / 记录不读时钟；调度、动画、HUD 通过这里拿时间。

/** 单调毫秒时钟（动画、调度、输入延迟打点）。 */
export const now = () => performance.now();

/** 墙钟毫秒（记录文件名、存档时间戳）。 */
export const wallNow = () => Date.now();

/**
 * 逐帧回调：cb(t, dt)，t = now()，dt 为与上一帧的间隔（ms，首帧 0，上限 100 防切后台回来时的大跳）。
 * @returns {() => void} 停止函数
 */
export function frameLoop(cb) {
  let last = 0;
  let id = 0;
  let alive = true;
  const tick = () => {
    if (!alive) return;
    const t = now();
    const dt = last ? Math.min(t - last, 100) : 0;
    last = t;
    cb(t, dt);
    id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return () => {
    alive = false;
    cancelAnimationFrame(id);
  };
}

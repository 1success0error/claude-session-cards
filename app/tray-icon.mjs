// 托盘图标：紫色圆角方块里两行“状态点 + 横条”，代表卡片列表。按尺寸现画，高分屏不发虚。
const BACKGROUND = [122, 63, 214];
const FOREGROUND = [255, 255, 255];

const roundedRect = (x, y, cx, cy, halfW, halfH, radius) => {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
};
const circle = (x, y, cx, cy, radius) => Math.hypot(x - cx, y - cy) - radius;

/** 返回 size x size 的预乘 BGRA 位图，距离场抗锯齿。 */
export function drawIcon(size) {
  const buffer = Buffer.alloc(size * size * 4);
  const coverage = (distance) => Math.max(0, Math.min(1, 0.5 - distance * size));
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      const shape = coverage(roundedRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.2));
      if (!shape) continue;
      let ink = 0;
      for (const row of [0.33, 0.67]) {
        ink = Math.max(
          ink,
          coverage(circle(x, y, 0.27, row, 0.095)),
          coverage(roundedRect(x, y, 0.61, row, 0.21, 0.07, 0.07)),
        );
      }
      const i = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const color = BACKGROUND[channel] * (1 - ink) + FOREGROUND[channel] * ink;
        buffer[i + 2 - channel] = Math.round(color * shape);
      }
      buffer[i + 3] = Math.round(shape * 255);
    }
  }
  return buffer;
}

const SCALES = [[1, 16], [1.25, 20], [1.5, 24], [2, 32], [3, 48]];

/** 各种显示缩放都有对应尺寸的位图，系统缩放时不会发虚。 */
export function buildTrayImage(nativeImage) {
  const image = nativeImage.createFromBitmap(drawIcon(16), { width: 16, height: 16, scaleFactor: 1 });
  for (const [scaleFactor, size] of SCALES.slice(1)) {
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: drawIcon(size) });
  }
  return image;
}

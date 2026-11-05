const GAP = 8;
const MARGIN = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

/**
 * 把窗口放在 anchor 旁边并限制在 area 内：优先右侧，其次左侧，
 * 两边都放不下时选空间大的一侧（会和 anchor 重叠一部分）。顶部与 anchor 对齐。
 */
export function placeBeside(anchor, size, area) {
  const width = Math.min(size.width, area.width - MARGIN * 2);
  const height = Math.min(size.height, area.height - MARGIN * 2);
  const minX = area.x + MARGIN;
  const maxX = area.x + area.width - MARGIN - width;

  const rightX = anchor.x + anchor.width + GAP;
  const leftX = anchor.x - GAP - width;
  let x;
  if (rightX <= maxX) x = rightX;
  else if (leftX >= minX) x = leftX;
  else x = maxX - rightX >= leftX - minX ? rightX : leftX;

  return {
    x: clamp(x, minX, maxX),
    y: clamp(anchor.y, area.y + MARGIN, area.y + area.height - MARGIN - height),
    width,
    height,
  };
}

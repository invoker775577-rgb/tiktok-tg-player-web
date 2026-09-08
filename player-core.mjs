export const clampRate = (value) => Math.max(0.25, Math.min(3, Math.round((Number(value) || 1) * 100) / 100));

// A bounded scan: even an entirely broken, looping playlist must stop.
export function nextPlayable(queue, index, failed, { direction = 1, wrap = true } = {}) {
  for (let step = 1; step <= queue.length; step++) {
    const candidate = index + direction * step;
    if (!wrap && (candidate < 0 || candidate >= queue.length)) return -1;
    const at = ((candidate % queue.length) + queue.length) % queue.length;
    if (!failed.has(queue[at].file_id)) return at;
  }
  return -1;
}

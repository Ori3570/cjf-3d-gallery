// Bucket depth sorting, far to near. Positions stay in the worker; only indices move.
let xyz;
self.onmessage = ({data}) => {
  if (data.positions) { xyz = new Float32Array(data.positions); return; }
  if (!xyz) return;
  const count = xyz.length / 3, direction = data.direction;
  const depths = new Float32Array(count);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) {
    const j = i * 3;
    const depth = xyz[j] * direction[0] + xyz[j + 1] * direction[1] + xyz[j + 2] * direction[2];
    depths[i] = depth; min = Math.min(min, depth); max = Math.max(max, depth);
  }
  const bins = new Uint32Array(65536), keys = new Uint16Array(count);
  const factor = 65535 / Math.max(max - min, 1e-8);
  for (let i = 0; i < count; i++) {
    const key = Math.min(65535, Math.max(0, Math.floor((max - depths[i]) * factor)));
    keys[i] = key; bins[key]++;
  }
  let offset = 0;
  for (let i = 0; i < bins.length; i++) { const n = bins[i]; bins[i] = offset; offset += n; }
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[bins[keys[i]]++] = i;
  self.postMessage({indices: indices.buffer, direction}, [indices.buffer]);
};

const $ = selector => document.querySelector(selector);
const canvas = $('#scene'), stage = $('#stage'), status = $('#status');
const loading = $('#loading'), progress = $('#progress'), readout = $('#camera-readout');
const motionButton = $('#motion'), panButton = $('#pan');
let gl, cfg, program, indicesBuffer, worker, ready = false, videoMode = false;
let orbit = false, panMode = false, frameId = 0, dirty = true, needsSort = true;
let sortBusy = false, lastSort = 0, lastDraw = 0, lastFrame = 0, animationTime = 0;
let uniform, pose = { yaw: 0, pitch: 0, distance: 1, panX: 0, panY: 0 };
let positions, sortDirection = [0, 0, 1], glResources = [];
const pointers = new Map();
const TAU = Math.PI * 2;
const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3500); }
function setOrbit(value) { orbit = value; motionButton.setAttribute('aria-pressed', String(value)); motionButton.innerHTML = value ? '<span aria-hidden="true">Ⅱ</span> 暂停环绕' : '<span aria-hidden="true">▷</span> 自动环绕'; }
function reset() { setOrbit(false); pose = { yaw: 0, pitch: 0, distance: cfg.focusDepth, panX: 0, panY: 0 }; dirty = true; needsSort = true; }
function onChange() { dirty = true; needsSort = true; $('#gesture-hint').hidden = true; }
function camera() {
  const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw), cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
  const right = [cy, 0, -sy], down = [-sy * sp, cp, -cy * sp], forward = [sy * cp, sp, cy * cp];
  const eye = [0, 0, cfg.focusDepth].map((v, k) => v - forward[k] * pose.distance + right[k] * pose.panX + down[k] * pose.panY);
  // WebGL matrices use column-major order. Rows are right, down and forward.
  const rotation = new Float32Array([right[0], down[0], forward[0], right[1], down[1], forward[1], right[2], down[2], forward[2]]);
  return { eye, rotation, forward };
}
function compile(type, source) {
  const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw Error(error); }
  glResources.push(['shader', shader]); return shader;
}
const vertex = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 corner;
layout(location=1) in uint gaussianId;
uniform highp sampler2D sceneData;
uniform int textureWidth;
uniform vec3 eye;
uniform mat3 rotation;
uniform vec2 viewport;
uniform float focal;
out vec2 local;
flat out vec4 color;
flat out vec3 invCov;
vec4 readTexel(int n) { return texelFetch(sceneData, ivec2(n % textureWidth, n / textureWidth), 0); }
void main() {
 int offset = int(gaussianId) * 4;
 vec3 center = readTexel(offset).xyz;
 color = readTexel(offset + 1);
 vec3 covA = readTexel(offset + 2).xyz;
 vec3 covB = readTexel(offset + 3).xyz;
 vec3 p = rotation * (center - eye);
 float z = p.z;
 if (z < 0.01) { gl_Position = vec4(2.,2.,0.,1.); local = vec2(0.); invCov = vec3(1.,0.,1.); return; }
 mat3 covariance = mat3(covA.x,covA.y,covA.z,covA.y,covB.x,covB.y,covA.z,covB.y,covB.z);
 covariance = rotation * covariance * transpose(rotation);
 vec3 jx = vec3(focal/z,0.,-focal*p.x/(z*z));
 vec3 jy = vec3(0.,focal/z,-focal*p.y/(z*z));
 float a = dot(jx,covariance*jx)+0.3, b = dot(jx,covariance*jy), d = dot(jy,covariance*jy)+0.3;
 float det = max(a*d-b*b,1e-8);
 invCov = vec3(d,-b,a)/det;
 float mid = (a+d)*0.5, delta = sqrt(max(0.,mid*mid-det));
 float l1 = max(mid+delta,0.1), l2 = max(mid-delta,0.1);
 vec2 axis = abs(b)>1e-6 ? normalize(vec2(b,l1-a)) : (a>=d ? vec2(1.,0.) : vec2(0.,1.));
 vec2 ortho = vec2(-axis.y,axis.x);
 local = corner.x*axis*min(3.*sqrt(l1),1024.) + corner.y*ortho*min(3.*sqrt(l2),1024.);
 vec2 projected = focal*p.xy/z + local;
 gl_Position = vec4(2.*projected.x/viewport.x,-2.*projected.y/viewport.y,0.,1.);
}`;
const fragment = `#version 300 es
precision highp float;
in vec2 local;
flat in vec4 color;
flat in vec3 invCov;
out vec4 frag;
void main() {
 float power = -0.5*(invCov.x*local.x*local.x+2.*invCov.y*local.x*local.y+invCov.z*local.y*local.y);
 if (power>0. || power < -4.5) discard;
 float alpha = min(0.99,color.a*exp(power));
 if (alpha<0.0039) discard;
 frag = vec4(color.rgb,alpha);
}`;
// One long-lived connection can silently degrade to a crawl on long routes.
// Download in parallel range chunks; a chunk whose stream stalls is aborted
// and retried on a fresh connection.
async function fetchRange(url, start, end, onData, stallMs) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), stallMs);
  try {
    const response = await fetch(url, {headers: {Range: `bytes=${start}-${end}`}, signal: controller.signal});
    if (response.status !== 206) throw Error('服务器不支持断点下载');
    const reader = response.body.getReader(), pieces = [];
    let received = 0;
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      clearTimeout(timer); timer = setTimeout(() => controller.abort(), stallMs);
      pieces.push(value); received += value.byteLength; onData(value.byteLength);
    }
    if (received !== end - start + 1) throw Error('分块长度不符');
    const whole = new Uint8Array(received);
    let offset = 0;
    for (const piece of pieces) { whole.set(piece, offset); offset += piece.byteLength; }
    return whole;
  } finally { clearTimeout(timer); }
}
async function probeRange(url) {
  for (let attempt = 0; ; attempt++) {
    try { await fetchRange(url, 0, 0, () => {}, 10000); return true; }
    catch (error) {
      if (error.message === '服务器不支持断点下载') return false;
      if (attempt >= 2) throw Error('网络不稳定，请重新加载');
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
}
async function downloadScene(url, total) {
  if (!await probeRange(url)) return null;
  const CHUNK = 4 * 1048576, PARALLEL = 4, ATTEMPTS = 6, STALL = 10000;
  const chunkCount = Math.ceil(total / CHUNK), parts = new Array(chunkCount);
  let received = 0, next = 0;
  const report = () => {
    progress.value = Math.min(90, received / total * 90);
    status.textContent = `加载三维数据 ${Math.min(100, Math.round(received / total * 100))}% · ${(total / 1048576).toFixed(1)} MB`;
  };
  const workers = Array.from({length: Math.min(PARALLEL, chunkCount)}, async () => {
    while (next < chunkCount) {
      const index = next++, start = index * CHUNK, end = Math.min(total, start + CHUNK) - 1;
      for (let attempt = 1; ; attempt++) {
        let counted = 0;
        try {
          parts[index] = await fetchRange(url, start, end, bytes => { counted += bytes; received += bytes; report(); }, STALL);
          break;
        } catch (error) {
          received -= counted;
          if (attempt >= ATTEMPTS) throw Error('网络不稳定，模型下载多次中断，请重新加载');
          await new Promise(resolve => setTimeout(resolve, 300 * attempt));
        }
      }
    }
  });
  await Promise.all(workers);
  const whole = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { whole.set(part, offset); offset += part.byteLength; }
  if (offset !== total) throw Error('模型文件不完整，请重新加载');
  return whole;
}
async function loadScene() {
  const configResponse = await fetch('assets/scene.json');
  if (!configResponse.ok) throw Error('场景信息读取失败');
  cfg = await configResponse.json();
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
  if (!gl || typeof DecompressionStream === 'undefined') throw Error('当前浏览器暂不支持交互三维，请先看动态视频');
  const total = cfg.compressedBytes;
  const chunked = await downloadScene('assets/scene.bin.gz', total);
  let compressed;
  if (chunked) {
    compressed = new Blob([chunked]);
  } else {
    // Server without Range support: plain single stream.
    const response = await fetch('assets/scene.bin.gz');
    if (!response.ok) throw Error('模型文件读取失败，请重新加载');
    const reader = response.body.getReader(), chunks = [];
    let received = 0;
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      chunks.push(value); received += value.byteLength;
      progress.value = Math.min(90, received / total * 90);
      status.textContent = `加载三维数据 ${Math.min(100, Math.round(received / total * 100))}% · ${(total / 1048576).toFixed(1)} MB`;
    }
    compressed = new Blob(chunks);
  }
  status.textContent = '正在展开三维空间…';
  const decompressed = compressed.stream().pipeThrough(new DecompressionStream('gzip'));
  const buffer = await new Response(decompressed).arrayBuffer();
  if (buffer.byteLength !== cfg.count * 52) throw Error('模型文件不完整，请重新加载');
  const data = new Float32Array(buffer);
  const width = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const height = Math.ceil(cfg.count * 4 / width);
  if (height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw Error('设备图形内存不足，请查看动态视频');
  const textureData = new Float32Array(width * height * 4);
  positions = new Float32Array(cfg.count * 3);
  for (let i = 0; i < cfg.count; i++) {
    const s = i * 13, t = i * 16;
    textureData.set(data.subarray(s, s + 3), t);
    textureData.set(data.subarray(s + 3, s + 7), t + 4);
    textureData.set(data.subarray(s + 7, s + 10), t + 8);
    textureData.set(data.subarray(s + 10, s + 13), t + 12);
    positions.set(data.subarray(s, s + 3), i * 3);
  }
  program = gl.createProgram(); glResources.push(['program', program]);
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao); glResources.push(['vao', vao]);
  const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); glResources.push(['buffer', quad]);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  indicesBuffer = gl.createBuffer(); glResources.push(['buffer', indicesBuffer]); gl.bindBuffer(gl.ARRAY_BUFFER, indicesBuffer);
  const indices = new Uint32Array(cfg.count); for (let i = 0; i < cfg.count; i++) indices[i] = i;
  gl.bufferData(gl.ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(1);
  gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 4, 0); gl.vertexAttribDivisor(1, 1);
  const texture = gl.createTexture(); glResources.push(['texture', texture]); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, textureData);
  if (gl.getError() !== gl.NO_ERROR) throw Error('三维数据无法放入显存，请查看动态视频');
  gl.uniform1i(gl.getUniformLocation(program, 'sceneData'), 0); gl.uniform1i(gl.getUniformLocation(program, 'textureWidth'), width);
  uniform = Object.fromEntries(['eye', 'rotation', 'viewport', 'focal'].map(name => [name, gl.getUniformLocation(program, name)]));
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
  worker = new Worker('sort-worker.js');
  worker.onerror = () => fail(Error('视角排序失败，请重新加载'));
  worker.onmessage = ({data: result}) => {
    if (!ready) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, indicesBuffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint32Array(result.indices));
    sortDirection = result.direction; sortBusy = false; dirty = true;
  };
  worker.postMessage({positions: positions.buffer}, [positions.buffer]); positions = null;
  ready = true; canvas.hidden = false; $('#poster').hidden = true; loading.hidden = true;
  progress.value = 100; $('#gesture-hint').hidden = false;
  ['reset', 'motion', 'pan'].forEach(id => $('#' + id).disabled = false);
  $('#scene-info').textContent = `${(cfg.count / 10000).toFixed(1)} 万个三维高斯 · 自由视角`;
  reset(); frameId = requestAnimationFrame(draw);
}
function draw(time) {
  if (!ready) return;
  const dt = Math.min((time - lastFrame) / 1000, .05); lastFrame = time;
  if (!document.hidden && !videoMode) {
    if (orbit) { animationTime += dt; pose.yaw += dt * .14; pose.pitch = Math.sin(animationTime * .35) * .16; onChange(); }
    if (dirty && time - lastDraw >= 33) {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const scale = Math.min(dpr, 1200 / Math.max(stage.clientWidth, stage.clientHeight));
      const w = Math.max(1, Math.round(stage.clientWidth * scale)), h = Math.max(1, Math.round(stage.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const view = camera();
      gl.viewport(0, 0, w, h); gl.clearColor(.085, .085, .075, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform3fv(uniform.eye, view.eye); gl.uniformMatrix3fv(uniform.rotation, false, view.rotation); gl.uniform2f(uniform.viewport, w, h);
      gl.uniform1f(uniform.focal, cfg.focal * Math.min(w / cfg.width, h / cfg.height));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cfg.count);
      const yaw = ((pose.yaw * 180 / Math.PI % 360) + 540) % 360 - 180;
      const pitch = pose.pitch * 180 / Math.PI;
      readout.textContent = Math.abs(yaw) < .5 && Math.abs(pitch) < .5 && Math.abs(pose.distance / cfg.focusDepth - 1) < .01 && Math.abs(pose.panX) < .001 && Math.abs(pose.panY) < .001 ? '原视角' : `环绕 ${Math.round(yaw)}° · 俯仰 ${Math.round(pitch)}° · ${(cfg.focusDepth / pose.distance).toFixed(1)}×`;
      if (!sortBusy && needsSort && time - lastSort > 100) {
        const diff = view.forward.reduce((sum, v, k) => sum + (v - sortDirection[k]) ** 2, 0);
        if (diff > 1e-7) { sortBusy = true; worker.postMessage({direction: view.forward}); lastSort = time; }
        needsSort = false;
      }
      // A pending sort must match the latest camera before settling.
      if (!sortBusy && view.forward.some((v, k) => Math.abs(v - sortDirection[k]) > .0003)) needsSort = true;
      dirty = sortBusy || needsSort; lastDraw = time;
    }
  }
  frameId = requestAnimationFrame(draw);
}
function fail(error) {
  ready = false; setOrbit(false); cancelAnimationFrame(frameId); worker?.terminate();
  if (gl) for (const [type, resource] of glResources) {
    const methods = {shader: 'deleteShader', program: 'deleteProgram', vao: 'deleteVertexArray', buffer: 'deleteBuffer', texture: 'deleteTexture'};
    gl[methods[type]](resource);
  }
  glResources = []; canvas.hidden = true; $('#poster').hidden = videoMode; loading.hidden = videoMode;
  progress.hidden = true; status.textContent = error.message; $('#retry').hidden = false;
  $('#scene-info').textContent = '可切换动态视频预览';
  ['reset', 'motion', 'pan'].forEach(id => $('#' + id).disabled = true);
  console.error(error);
}
canvas.addEventListener('pointerdown', e => {
  if (!ready) return; setOrbit(false); canvas.focus({preventScroll: true});
  pointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); canvas.setPointerCapture(e.pointerId); e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const previous = pointers.get(e.pointerId), current = {x: e.clientX, y: e.clientY};
  if (pointers.size === 2) {
    const other = [...pointers].find(([id]) => id !== e.pointerId)[1];
    const oldLength = Math.hypot(previous.x - other.x, previous.y - other.y), newLength = Math.hypot(current.x - other.x, current.y - other.y);
    if (newLength > 2) pose.distance = clamp(pose.distance * oldLength / newLength, cfg.focusDepth * .05, cfg.focusDepth * 8);
    pan(current.x - previous.x, current.y - previous.y, .5);
  } else if (panMode || e.shiftKey || e.buttons === 2) {
    pan(current.x - previous.x, current.y - previous.y, 1);
  } else {
    pose.yaw -= (current.x - previous.x) / Math.max(canvas.clientWidth, 1) * TAU;
    pose.pitch = clamp(pose.pitch + (current.y - previous.y) / Math.max(canvas.clientHeight, 1) * Math.PI, -1.5, 1.5);
  }
  pointers.set(e.pointerId, current); onChange();
});
function pan(dx, dy, factor) {
  const projectionScale = cfg.focal * Math.min(canvas.clientWidth / cfg.width, canvas.clientHeight / cfg.height);
  pose.panX -= dx * pose.distance / projectionScale * factor; pose.panY -= dy * pose.distance / projectionScale * factor;
}
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => canvas.addEventListener(type, e => pointers.delete(e.pointerId)));
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => { e.preventDefault(); if (!ready) return; setOrbit(false); pose.distance = clamp(pose.distance * Math.exp(clamp(e.deltaY, -150, 150) * .002), cfg.focusDepth * .05, cfg.focusDepth * 8); onChange(); }, {passive: false});
canvas.addEventListener('keydown', e => {
  if (!ready) return;
  const step = Math.PI / 18;
  if (e.key.toLowerCase() === 'r') { reset(); e.preventDefault(); return; }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(e.key)) return;
  setOrbit(false); e.preventDefault();
  if (e.key === 'ArrowLeft') pose.yaw -= step;
  if (e.key === 'ArrowRight') pose.yaw += step;
  if (e.key === 'ArrowUp') pose.pitch = clamp(pose.pitch - step, -1.5, 1.5);
  if (e.key === 'ArrowDown') pose.pitch = clamp(pose.pitch + step, -1.5, 1.5);
  if (e.key === '+' || e.key === '=') pose.distance *= .9;
  if (e.key === '-') pose.distance *= 1.1;
  pose.distance = clamp(pose.distance, cfg.focusDepth * .05, cfg.focusDepth * 8); onChange();
});
$('#reset').onclick = () => { if (videoMode) toggleVideo(); reset(); };
motionButton.onclick = () => { if (videoMode) toggleVideo(); setOrbit(!orbit); };
panButton.onclick = () => { panMode = !panMode; panButton.setAttribute('aria-pressed', String(panMode)); toast(panMode ? '平移模式：拖动移动位置' : '环绕模式：拖动旋转视角'); };
function toggleVideo() {
  videoMode = !videoMode; const video = $('#fallback-video'); video.hidden = !videoMode;
  canvas.hidden = !ready || videoMode; $('#poster').hidden = ready || videoMode; loading.hidden = ready || videoMode;
  $('#gesture-hint').hidden = videoMode || !ready; $('#video').textContent = videoMode ? '返回 3D' : '视频';
  if (videoMode) { setOrbit(false); video.play().catch(() => {}); } else { video.pause(); dirty = true; }
}
$('#video').onclick = toggleVideo;
$('#retry').onclick = () => location.reload();
$('#fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if (stage.requestFullscreen) await stage.requestFullscreen(); else toast('此浏览器暂不支持全屏，可以横屏查看'); } catch { toast('无法进入全屏，可以横屏查看'); } };
$('#share').onclick = async () => {
  const url = location.href.split('#')[0];
  try {
    if (navigator.share) await navigator.share({title: document.title, text: '拖动，换一个角度看这张照片。', url});
    else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); toast('链接已复制'); }
    else { window.prompt('复制此链接分享', url); }
  } catch (e) { if (e.name !== 'AbortError') window.prompt('复制此链接分享', url); }
};
canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); fail(Error('图形连接已中断，请重新加载或查看视频')); });
window.addEventListener('resize', () => dirty = true);
document.addEventListener('fullscreenchange', () => dirty = true);
document.addEventListener('visibilitychange', () => { lastFrame = performance.now(); dirty = true; });
loadScene().catch(fail);

// AI Video Editor frontend: media bin, preview transport, multi-track timeline,
// agent chat with tool traces. All edits (mouse or agent) go through the same op API.

const $ = id => document.getElementById(id);
const fileInput = $('fileInput'), uploadArea = $('uploadArea'), mediaList = $('mediaList');
const previewFrame = $('previewFrame'), emptyHint = $('emptyHint');
const playBtn = $('playBtn'), timeDisplay = $('timeDisplay');
const tlScroll = $('tlScroll'), tlInner = $('tlInner'), tlRuler = $('tlRuler'), tlTracks = $('tlTracks'), tlPlayhead = $('tlPlayhead');
const chatLog = $('chatLog'), chatInput = $('chatInput'), chatSend = $('chatSend');
const toastEl = $('toast');

const TRACK_DEFS = [
  { id: 'V1', label: 'V1', height: 52 },
  { id: 'O1', label: 'O1', height: 30 },
  { id: 'O2', label: 'O2', height: 30 },
  { id: 'C1', label: 'C1', height: 26 },
  { id: 'A1', label: 'A1', height: 40 }
];
const GUTTER = 46;

const state = {
  edl: null,
  duration: 0,
  assets: [],
  cursor: 0,
  historyLength: 0,
  selection: null,
  pps: 60, // pixels per second
  exportJobId: null,
  agentBusy: false,
  dragging: false,
  analyzingCount: 0
};

let statusTimeout;
function showToast(text, type = 'info', duration = 3500) {
  clearTimeout(statusTimeout);
  toastEl.textContent = text;
  toastEl.className = `toast show ${type}`;
  statusTimeout = setTimeout(() => toastEl.classList.remove('show'), duration);
}

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

// --- API -------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || body.error || `${path} failed (${res.status})`);
  return body;
}

async function runOp(op, params) {
  try {
    const r = await api('/api/ops', { method: 'POST', body: JSON.stringify({ op, params }) });
    state.historyLength = r.cursor; // a commit truncates any redo branch
    setEDL(r.edl, r.duration, r.cursor);
    showToast(r.summary, 'success', 2000);
    return r;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

// --- preview sync ------------------------------------------------------------

function previewAPI() {
  return previewFrame.contentWindow?.PreviewAPI;
}

function assetUrlMap() {
  const map = {};
  for (const a of state.assets) map[a.id] = a.proxyUrl || a.url;
  return map;
}

function setEDL(edl, duration, cursor) {
  state.edl = edl;
  state.duration = duration ?? state.duration;
  if (cursor !== undefined) state.cursor = cursor;
  if (state.selection && !findClip(state.selection)) state.selection = null;
  previewAPI()?.setEDL(edl, assetUrlMap());
  emptyHint.classList.toggle('hidden', state.duration > 0);
  renderTimeline();
  updateSelInfo();
}

function findClip(clipId) {
  for (const track of state.edl?.tracks || []) {
    const clip = track.clips.find(c => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

// --- boot + asset polling ------------------------------------------------------

async function loadProject() {
  const p = await api('/api/project');
  state.assets = p.assets;
  state.historyLength = p.historyLength;
  setEDL(p.edl, p.duration, p.cursor);
  renderMedia();
  if (p.capabilities.mcpCommand) $('mcpCmd').textContent = p.capabilities.mcpCommand;
  if (!p.capabilities.whisper) showToast('whisper.cpp not found — captions/transcripts disabled', 'error', 6000);
  scheduleAssetPoll();
}

let assetPollTimer = null;
function scheduleAssetPoll() {
  clearTimeout(assetPollTimer);
  if (!state.assets.some(a => a.status === 'analyzing')) return;
  assetPollTimer = setTimeout(async () => {
    try {
      const { assets } = await api('/api/assets');
      const before = new Set(state.assets.filter(a => a.status === 'ready').map(a => a.id));
      state.assets = assets;
      renderMedia();
      for (const a of assets) {
        if (a.status === 'ready' && !before.has(a.id)) showToast(`${a.name} analyzed — ${a.analysis.tags.join(', ') || 'ready'}`, 'success');
      }
      previewAPI()?.setEDL(state.edl, assetUrlMap());
    } catch { /* transient */ }
    scheduleAssetPoll();
  }, 1200);
}

// --- media bin -----------------------------------------------------------------

const STAGE_LABELS = { metadata: 'probe', proxy: 'proxy', scenes: 'scenes', silence: 'audio map', waveform: 'waveform', beats: 'beats', transcript: 'transcript', done: 'done', cached: 'cached' };

// Media items update in place so thumbnails don't reload/flicker on every
// analysis-status poll.
const mediaNodes = new Map(); // assetId -> { root, statusBox, actionsBox, sig }

function buildMediaItem(asset) {
  const root = document.createElement('div');
  root.className = 'media-item';

  let thumb;
  if (asset.type === 'image') {
    thumb = `<img class="thumb" src="${asset.url}" alt="">`;
  } else if (asset.type === 'video') {
    thumb = `<video class="thumb" src="${(asset.proxyUrl || asset.url)}#t=0.5" muted preload="metadata"></video>`;
  } else {
    thumb = `<div class="thumb audio-thumb">♪</div>`;
  }

  root.innerHTML = `
    <button class="remove" title="Remove">×</button>
    ${thumb}
    <div class="name" title="${esc(asset.name)}">${esc(asset.name)}</div>
    <div class="status-box"></div>
    <div class="a-actions"></div>`;

  root.querySelector('.remove').addEventListener('click', async () => {
    await api(`/api/assets/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
    state.assets = state.assets.filter(a => a.id !== asset.id);
    renderMedia();
    showToast('Asset removed', 'info');
  });

  return { root, statusBox: root.querySelector('.status-box'), actionsBox: root.querySelector('.a-actions'), sig: null };
}

function mediaSig(asset) {
  return `${asset.status}|${asset.stages?.length || 0}|${asset.analysis ? 1 : 0}`;
}

function updateMediaItem(node, asset) {
  const sig = mediaSig(asset);
  if (node.sig === sig) return;
  node.sig = sig;
  node.root.className = 'media-item' + (asset.status === 'analyzing' ? ' analyzing' : '');

  if (asset.status === 'analyzing') {
    const last = asset.stages[asset.stages.length - 1];
    node.statusBox.innerHTML = `<div class="a-status"><span class="spinner"></span> analyzing… ${esc(STAGE_LABELS[last] || 'starting')}</div>`;
  } else if (asset.status === 'error') {
    node.statusBox.innerHTML = `<div class="a-status error">analysis failed</div>`;
  } else if (asset.analysis) {
    const isImage = asset.type === 'image';
    const bits = [];
    if (!isImage && asset.analysis.meta.duration) bits.push(`${Math.round(asset.analysis.meta.duration * 10) / 10}s`);
    for (const t of asset.analysis.tags || []) bits.push(t);
    if (asset.analysis.bpm) bits.push(`${asset.analysis.bpm} bpm`);
    if (asset.analysis.scenes?.length) bits.push(`${asset.analysis.scenes.length + 1} scenes`);
    node.statusBox.innerHTML = `<div class="a-tags">${bits.map(b => `<span>${esc(b)}</span>`).join('')}</div>`;
  }

  node.actionsBox.innerHTML = `
    <button class="add" ${asset.status !== 'ready' ? 'disabled' : ''}>+ Add</button>
    ${asset.analysis?.highlight ? `<button class="best" title="Add just the suggested highlight ${asset.analysis.highlight.start}–${asset.analysis.highlight.end}s">★ Best</button>` : ''}`;
  node.actionsBox.querySelector('.add').addEventListener('click', () => addAssetToTimeline(asset));
  node.actionsBox.querySelector('.best')?.addEventListener('click', () => addAssetToTimeline(asset, asset.analysis.highlight));
}

function renderMedia() {
  const seen = new Set();
  for (const asset of state.assets) {
    seen.add(asset.id);
    let node = mediaNodes.get(asset.id);
    if (!node) {
      node = buildMediaItem(asset);
      mediaNodes.set(asset.id, node);
      mediaList.appendChild(node.root);
    }
    updateMediaItem(node, asset);
  }
  for (const [id, node] of mediaNodes) {
    if (!seen.has(id)) {
      node.root.remove();
      mediaNodes.delete(id);
    }
  }
}

function trackEnd(trackId) {
  const track = state.edl.tracks.find(t => t.id === trackId);
  return track.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
}

function addAssetToTimeline(asset, range = null) {
  const trackId = asset.type === 'audio' ? 'A1' : 'V1';
  const mediaDur = asset.analysis?.meta?.duration || 3;
  const inPoint = range ? range.start : 0;
  const duration = range ? range.end - range.start : (asset.type === 'image' ? 3 : mediaDur);
  runOp('addClip', { trackId, assetId: asset.id, start: trackEnd(trackId), duration: Math.round(duration * 100) / 100, in: inPoint });
}

async function uploadFiles(files) {
  if (!files.length) return;
  showToast('Uploading…', 'info', 20000);
  const formData = new FormData();
  for (const f of files) formData.append('files', f);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    const { assets } = await res.json();
    state.assets = state.assets.concat(assets);
    renderMedia();
    scheduleAssetPoll();
    showToast(`${assets.length} file(s) importing — analysis running`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

uploadArea.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { uploadFiles([...e.target.files]); fileInput.value = ''; });
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  uploadFiles([...e.dataTransfer.files]);
});

// --- timeline ---------------------------------------------------------------------

function tlWidth() {
  return Math.max(state.duration + 6, 30) * state.pps + GUTTER;
}

function renderTimeline() {
  if (!state.edl) return;
  tlInner.style.width = tlWidth() + 'px';
  renderRuler();
  tlTracks.textContent = '';

  for (const def of TRACK_DEFS) {
    const track = state.edl.tracks.find(t => t.id === def.id);
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.style.height = def.height + 'px';

    const label = document.createElement('div');
    label.className = 'tl-label';
    label.textContent = def.label;
    row.appendChild(label);

    const lane = document.createElement('div');
    lane.className = 'tl-lane';
    lane.dataset.track = def.id;

    for (const clip of track.clips) {
      lane.appendChild(buildClipDiv(clip, track, def));
    }
    row.appendChild(lane);
    tlTracks.appendChild(row);
  }
  updatePlayheadPos();
}

function buildClipDiv(clip, track, def) {
  const el = document.createElement('div');
  el.className = `tl-clip t-${clip.type}` + (state.selection === clip.id ? ' selected' : '');
  el.style.left = (clip.start * state.pps) + 'px';
  el.style.width = Math.max(4, clip.duration * state.pps) + 'px';
  el.dataset.clip = clip.id;

  const label = clip.type === 'text' || clip.type === 'caption'
    ? (clip.text || '').slice(0, 30)
    : (state.assets.find(a => a.id === clip.assetId)?.name || clip.assetId || '');
  const extras = [];
  if (clip.speed !== 1) extras.push(`${clip.speed}x`);
  if (clip.muted) extras.push('🔇');
  el.innerHTML = `<span class="c-label">${esc(`${extras.join(' ')} ${label}`)}</span><div class="h h-l"></div><div class="h h-r"></div>`;

  // waveform for audio clips
  const asset = state.assets.find(a => a.id === clip.assetId);
  if ((clip.type === 'audio' || clip.type === 'video') && asset?.analysis?.peaks && def.id === 'A1') {
    el.appendChild(waveformCanvas(clip, asset, def.height - 4));
  }
  // scene notches on video clips
  if (clip.type === 'video' && asset?.analysis?.scenes?.length) {
    for (const s of asset.analysis.scenes) {
      const t = (s - clip.in) / clip.speed;
      if (t > 0.1 && t < clip.duration - 0.1) {
        const n = document.createElement('div');
        n.className = 'scene-notch';
        n.style.left = (t * state.pps) + 'px';
        el.appendChild(n);
      }
    }
  }
  // beat ticks on audio clips
  if (clip.type === 'audio' && asset?.analysis?.beats?.length) {
    for (const b of asset.analysis.beats.slice(0, 400)) {
      const t = (b - clip.in) / clip.speed;
      if (t > 0 && t < clip.duration) {
        const n = document.createElement('div');
        n.className = 'beat-tick';
        n.style.left = (t * state.pps) + 'px';
        el.appendChild(n);
      }
    }
  }

  el.addEventListener('mousedown', e => onClipMouseDown(e, clip, track));
  return el;
}

function waveformCanvas(clip, asset, height) {
  const canvas = document.createElement('canvas');
  canvas.className = 'wave';
  const w = Math.max(10, Math.round(clip.duration * state.pps));
  canvas.width = w;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const peaks = asset.analysis.peaks;
  const assetDur = asset.analysis.meta.duration || 1;
  const mediaLen = clip.duration * clip.speed;
  for (let x = 0; x < w; x += 2) {
    const mediaT = clip.in + (x / w) * mediaLen;
    const idx = Math.min(peaks.length - 1, Math.floor((mediaT / assetDur) * peaks.length));
    const p = peaks[idx] || 0;
    const h = Math.max(1, p * height);
    ctx.fillRect(x, (height - h) / 2, 1.4, h);
  }
  return canvas;
}

function renderRuler() {
  tlRuler.textContent = '';
  const total = tlWidth() / state.pps;
  const major = state.pps > 100 ? 1 : state.pps > 40 ? 5 : 10;
  const minor = major / 5;
  for (let t = 0; t <= total; t += minor) {
    const tick = document.createElement('div');
    const isMajor = Math.abs(t % major) < 1e-6 || major - (t % major) < 1e-6;
    tick.className = 'tick' + (isMajor ? ' major' : '');
    tick.style.left = (GUTTER + t * state.pps) + 'px';
    if (isMajor) tick.innerHTML = `<span>${fmt(t)}</span>`;
    tlRuler.appendChild(tick);
  }
}

// scrubbing
let scrubbing = false;
tlRuler.addEventListener('mousedown', e => {
  scrubbing = true;
  seekFromEvent(e);
});
document.addEventListener('mousemove', e => { if (scrubbing) seekFromEvent(e); });
document.addEventListener('mouseup', () => { scrubbing = false; });

function seekFromEvent(e) {
  const rect = tlInner.getBoundingClientRect();
  const t = Math.max(0, (e.clientX - rect.left - GUTTER) / state.pps);
  previewAPI()?.pause();
  previewAPI()?.seek(t);
  setPlayingUI(false);
  updatePlayheadPos();
}

function updatePlayheadPos() {
  const t = previewAPI()?.getTime() || 0;
  tlPlayhead.style.left = (GUTTER + t * state.pps) + 'px';
}

// clip drag + trim (optimistic move, server commit on mouseup)
function onClipMouseDown(e, clip, track) {
  e.stopPropagation();
  state.selection = clip.id;
  state.dragging = true;
  renderTimeline();

  const el = tlTracks.querySelector(`[data-clip="${clip.id}"]`);
  const mode = e.target.classList.contains('h-l') ? 'trim-l' : e.target.classList.contains('h-r') ? 'trim-r' : 'move';
  const startX = e.clientX;
  const orig = { start: clip.start, duration: clip.duration };
  let moved = false;

  function onMove(ev) {
    const dt = (ev.clientX - startX) / state.pps;
    if (Math.abs(ev.clientX - startX) > 3) moved = true;
    if (!moved) return;
    if (mode === 'move') {
      el.style.left = Math.max(0, (orig.start + dt) * state.pps) + 'px';
    } else if (mode === 'trim-r') {
      el.style.width = Math.max(6, (orig.duration + dt) * state.pps) + 'px';
    } else {
      const ns = Math.min(orig.start + orig.duration - 0.1, Math.max(0, orig.start + dt));
      el.style.left = (ns * state.pps) + 'px';
      el.style.width = ((orig.start + orig.duration - ns) * state.pps) + 'px';
    }
  }

  async function onUp(ev) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    state.dragging = false;
    if (!moved) { updateSelInfo(); return; }
    const dt = (ev.clientX - startX) / state.pps;
    const snap = v => Math.round(Math.max(0, v) * 20) / 20;
    try {
      if (mode === 'move') await runOp('moveClip', { clipId: clip.id, start: snap(orig.start + dt) });
      else if (mode === 'trim-r') await runOp('trimClip', { clipId: clip.id, newEnd: snap(orig.start + Math.max(0.1, orig.duration + dt)) });
      else await runOp('trimClip', { clipId: clip.id, newStart: Math.min(snap(orig.start + dt), orig.start + orig.duration - 0.1) });
    } catch {
      renderTimeline(); // revert optimistic move
    }
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

tlTracks.addEventListener('mousedown', e => {
  if (e.target.classList.contains('tl-lane')) {
    state.selection = null;
    renderTimeline();
  }
});

function updateSelInfo() {
  const info = $('selInfo');
  const found = state.selection && findClip(state.selection);
  if (!found) { info.textContent = ''; return; }
  const { clip } = found;
  info.textContent = `${clip.type} · ${fmt(clip.start)}–${fmt(clip.start + clip.duration)}${clip.speed !== 1 ? ` · ${clip.speed}x` : ''}`;
}

// --- toolbar ----------------------------------------------------------------------

$('undoBtn').addEventListener('click', async () => {
  const r = await api('/api/undo', { method: 'POST' });
  setEDL(r.edl, r.duration, r.cursor);
});
$('redoBtn').addEventListener('click', async () => {
  const r = await api('/api/redo', { method: 'POST' });
  setEDL(r.edl, r.duration, r.cursor);
});
$('splitBtn').addEventListener('click', splitAtPlayhead);
$('deleteBtn').addEventListener('click', () => state.selection && runOp('deleteClip', { clipId: state.selection }));
$('rippleBtn').addEventListener('click', () => state.selection && runOp('rippleDelete', { clipId: state.selection }));
$('cloneBtn').addEventListener('click', () => state.selection && runOp('cloneClip', { clipId: state.selection }));
$('muteBtn').addEventListener('click', () => {
  const found = state.selection && findClip(state.selection);
  if (found) runOp('setClipProps', { clipId: state.selection, muted: !found.clip.muted });
});

function splitAtPlayhead() {
  const t = previewAPI()?.getTime() || 0;
  let target = state.selection && findClip(state.selection);
  if (target && (t <= target.clip.start || t >= target.clip.start + target.clip.duration)) target = null;
  if (!target) {
    for (const track of state.edl.tracks) {
      const clip = track.clips.find(c => t > c.start + 0.05 && t < c.start + c.duration - 0.05);
      if (clip && track.id === 'V1') { target = { track, clip }; break; }
      if (clip && !target) target = { track, clip };
    }
  }
  if (!target) return showToast('No clip under the playhead', 'error');
  runOp('splitClip', { clipId: target.clip.id, at: Math.round(t * 100) / 100 });
}

$('zoomRange').addEventListener('input', e => {
  state.pps = Number(e.target.value);
  renderTimeline();
});

// --- transport ----------------------------------------------------------------------

function setPlayingUI(playing) {
  playBtn.textContent = playing ? '❚❚' : '▶';
}

playBtn.addEventListener('click', () => {
  const api = previewAPI();
  if (!api) return;
  if (api.isPlaying()) { api.pause(); setPlayingUI(false); }
  else { api.play(); setPlayingUI(true); }
});

setInterval(() => {
  const api = previewAPI();
  if (!api) return;
  const t = api.getTime();
  timeDisplay.textContent = `${fmt(t)} / ${fmt(state.duration)}`;
  updatePlayheadPos();
  if (!api.isPlaying()) setPlayingUI(false);
}, 100);

// --- settings ----------------------------------------------------------------------

$('presetSelect').addEventListener('change', e => {
  const [w, h] = e.target.value.split('x').map(Number);
  runOp('setSettings', { width: w, height: h });
});
$('fpsSelect').addEventListener('change', e => runOp('setSettings', { fps: Number(e.target.value) }));
$('bgColor').addEventListener('change', e => runOp('setSettings', { background: e.target.value }));

function syncSettingsUI() {
  if (!state.edl) return;
  const { width, height, fps, background } = state.edl.settings;
  const preset = `${width}x${height}`;
  if ([...$('presetSelect').options].some(o => o.value === preset)) $('presetSelect').value = preset;
  $('fpsSelect').value = String(fps);
  $('bgColor').value = background;
}

// --- agent chat -----------------------------------------------------------------------

const PREFS_KEY = 'atl-prefs';
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ apiKey: $('aiApiKey').value, model: $('aiModel').value }));
  } catch { /* unavailable */ }
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (p.apiKey) $('aiApiKey').value = p.apiKey;
    if (p.model) $('aiModel').value = p.model;
  } catch { /* ignore */ }
}
$('aiApiKey').addEventListener('input', savePrefs);
$('aiModel').addEventListener('change', savePrefs);
$('keyBtn').addEventListener('click', () => $('keySettings').classList.toggle('hidden'));
$('toggleKey').addEventListener('click', () => {
  const inp = $('aiApiKey');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  $('toggleKey').textContent = inp.type === 'password' ? 'Show' : 'Hide';
});
$('copyMcp').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('mcpCmd').textContent);
    showToast('Command copied — paste it in Terminal', 'success');
  } catch {
    showToast('Copy failed — select the command manually', 'error');
  }
});
$('chatResetBtn').addEventListener('click', async () => {
  await api('/api/agent/reset', { method: 'POST' });
  chatLog.textContent = '';
  appendBubble('assistant', 'Conversation cleared. What next?');
});

function appendBubble(cls, html, asText = true) {
  const el = document.createElement('div');
  el.className = `chat-bubble ${cls}`;
  if (asText) el.textContent = html; else el.innerHTML = html;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function appendToolChip(container, name, summary, error) {
  const chip = document.createElement('div');
  chip.className = 'tool-chip' + (error ? ' error' : '');
  chip.innerHTML = `<span class="tool-name">${esc(name)}</span> ${esc(error || summary || '')}`;
  container.appendChild(chip);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || state.agentBusy) return;
  const apiKey = $('aiApiKey').value.trim();
  if (!apiKey) {
    $('keySettings').classList.remove('hidden');
    return showToast('Enter your Anthropic API key first (⚙)', 'error');
  }

  appendBubble('user', text);
  chatInput.value = '';
  state.agentBusy = true;
  chatSend.disabled = true;
  const trace = document.createElement('div');
  trace.className = 'tool-trace';
  chatLog.appendChild(trace);
  const thinking = appendBubble('assistant thinking', 'Working…');
  let cursorBefore = state.cursor;

  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, apiKey, model: $('aiModel').value })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Agent failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let gotText = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const eventMatch = raw.match(/^event: (.+)$/m);
        const dataMatch = raw.match(/^data: (.+)$/m);
        if (!eventMatch || !dataMatch) continue;
        const event = eventMatch[1];
        const data = JSON.parse(dataMatch[1]);

        if (event === 'tool') {
          appendToolChip(trace, data.name, data.summary, data.error);
          if (data.edl) {
            state.historyLength = data.cursor;
            setEDL(data.edl, data.duration, data.cursor); // optimistic live apply
          }
          syncSettingsUI();
        } else if (event === 'text') {
          thinking.classList.remove('thinking');
          thinking.textContent = data.text;
          gotText = true;
        } else if (event === 'done') {
          cursorBefore = data.cursorBefore;
          setEDL(data.edl, data.duration, data.cursor);
          syncSettingsUI();
          if (!gotText) { thinking.classList.remove('thinking'); thinking.textContent = 'Done.'; }
          if (data.cursor > data.cursorBefore) {
            const revert = document.createElement('button');
            revert.className = 'revert-btn';
            revert.textContent = `Revert ${data.cursor - data.cursorBefore} change(s)`;
            revert.addEventListener('click', async () => {
              const r = await api('/api/history/seek', { method: 'POST', body: JSON.stringify({ cursor: cursorBefore }) });
              setEDL(r.edl, r.duration, r.cursor);
              revert.disabled = true;
              revert.textContent = 'Reverted';
              showToast('Agent changes reverted', 'info');
            });
            trace.appendChild(revert);
          }
        } else if (event === 'error') {
          throw new Error(data.error);
        }
      }
    }
  } catch (err) {
    thinking.classList.remove('thinking');
    thinking.classList.add('error');
    thinking.textContent = err.message;
  } finally {
    state.agentBusy = false;
    chatSend.disabled = false;
    chatInput.focus();
  }
}

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

// --- export ------------------------------------------------------------------------

const exportOverlay = $('exportOverlay');
const genStage = $('genStage'), genBar = $('genBar'), genPct = $('genPct');

function setProgress(pct, stage) {
  genBar.style.width = pct + '%';
  genPct.textContent = Math.round(pct) + '%';
  if (stage) genStage.textContent = stage;
}

$('exportBtn').addEventListener('click', async () => {
  if (state.exportJobId) return;
  try {
    previewAPI()?.pause();
    setPlayingUI(false);
    $('exportVideo').classList.add('hidden');
    $('exportDone').classList.add('hidden');
    $('cancelBtn').classList.remove('hidden');
    exportOverlay.classList.remove('hidden');
    setProgress(0, 'Starting export…');
    const { jobId } = await api('/api/export', { method: 'POST', body: JSON.stringify({ quality: $('exportQuality').value }) });
    state.exportJobId = jobId;

    for (;;) {
      await new Promise(r => setTimeout(r, 600));
      const job = await api(`/api/jobs/${jobId}`);
      setProgress(job.progress, job.stage);
      if (job.status === 'done') {
        setProgress(100, 'Export complete');
        const v = $('exportVideo');
        v.src = job.result.outputUrl;
        v.classList.remove('hidden');
        $('downloadLink').href = job.result.outputUrl + '?download=1';
        $('exportDone').classList.remove('hidden');
        $('cancelBtn').classList.add('hidden');
        showToast(`Exported ${Math.round(job.result.size / 1024)} KB`, 'success');
        break;
      }
      if (job.status === 'error') throw new Error(job.error || 'Export failed');
      if (job.status === 'cancelled') { exportOverlay.classList.add('hidden'); break; }
    }
  } catch (err) {
    exportOverlay.classList.add('hidden');
    showToast(err.message, 'error', 8000);
  } finally {
    state.exportJobId = null;
  }
});

$('cancelBtn').addEventListener('click', () => {
  if (state.exportJobId) fetch(`/api/jobs/${state.exportJobId}`, { method: 'DELETE' });
});
$('closeExport').addEventListener('click', () => {
  $('exportVideo').pause?.();
  exportOverlay.classList.add('hidden');
});

// --- keyboard ------------------------------------------------------------------------

document.addEventListener('keydown', e => {
  const inField = ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName);
  if (inField) return;
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  else if (e.key === 's' || e.key === 'S') splitAtPlayhead();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) runOp('deleteClip', { clipId: state.selection });
  else if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); $('undoBtn').click(); }
  else if ((e.metaKey || e.ctrlKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) { e.preventDefault(); $('redoBtn').click(); }
});

// --- boot ----------------------------------------------------------------------------

// --- external change detection (MCP / other clients editing the same project) ---

setInterval(async () => {
  if (state.agentBusy || state.dragging || state.exportJobId || !state.edl) return;
  try {
    const s = await api('/api/status');
    const changed = s.cursor !== state.cursor
      || s.historyLength !== state.historyLength
      || s.assetCount !== state.assets.length
      || s.analyzing !== state.analyzingCount;
    state.analyzingCount = s.analyzing;
    if (changed) {
      const p = await api('/api/project');
      state.assets = p.assets;
      state.historyLength = p.historyLength;
      setEDL(p.edl, p.duration, p.cursor);
      renderMedia();
      syncSettingsUI();
    }
  } catch { /* server briefly unavailable */ }
}, 2000);

loadPrefs();
function boot() {
  loadProject().then(syncSettingsUI).catch(err => showToast(err.message, 'error'));
}
if (previewAPI()) boot();
else previewFrame.addEventListener('load', boot);

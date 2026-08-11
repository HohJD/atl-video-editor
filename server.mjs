import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import multer from 'multer';
import { emptyEDL, applyOp, edlDuration, toolDefinitions } from './server/edl.mjs';
import { analyzeAsset, whisperAvailable, groupWordsToCues } from './server/analyze.mjs';
import { prepareExportAssets, compileExport } from './server/compile.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const PROJECTS_DIR = process.env.ATL_PROJECTS_DIR || path.join(__dirname, 'projects');
const UPLOADS_DIR = process.env.ATL_UPLOADS_DIR || path.join(__dirname, 'uploads');
const CACHE_DIR = process.env.ATL_CACHE_DIR || path.join(__dirname, 'cache');
const CLI = path.join(__dirname, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
const NODE_EXE = process.env.ATL_NODE_EXE || process.execPath;
const PROJECT_FILE = path.join(PROJECTS_DIR, 'project.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-]/g, '-').replace(/-+/g, '-');
      cb(null, `${randomUUID().slice(0, 8)}-${safe}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

function assetType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'].includes(ext)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac'].includes(ext)) return 'audio';
  return 'other';
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Project state: one project, immutable commits, cursor-based undo/redo.

const project = {
  edl: emptyEDL(),
  history: [],   // { id, op, params, summary, diff, state, ts }
  cursor: 0,     // commits applied
  assets: {},    // id -> { id, filename, name, type, size, status, stages, analysis }
  agentMessages: []
};

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const slim = { ...project, agentMessages: project.agentMessages.slice(-40) };
      await fs.writeFile(PROJECT_FILE, JSON.stringify(slim), 'utf-8');
    } catch (err) {
      console.error('persist failed:', err.message);
    }
  }, 250);
}

async function restore() {
  try {
    const saved = JSON.parse(await fs.readFile(PROJECT_FILE, 'utf-8'));
    Object.assign(project, saved);
    for (const a of Object.values(project.assets)) {
      if (a.status === 'analyzing') a.status = 'error'; // interrupted analysis
    }
  } catch { /* fresh project */ }
}

function assetCtx() {
  const map = {};
  for (const [id, a] of Object.entries(project.assets)) {
    map[id] = { type: a.type, duration: a.analysis?.meta?.duration, filename: a.filename };
  }
  return map;
}

function commit(opName, params, source = 'user') {
  const result = applyOp(project.edl, opName, params, { assets: assetCtx() });
  project.history = project.history.slice(0, project.cursor);
  project.history.push({
    id: randomUUID().slice(0, 8),
    op: opName,
    params,
    summary: result.summary,
    diff: result.diff,
    state: result.state,
    source,
    ts: Date.now()
  });
  project.cursor = project.history.length;
  project.edl = result.state;
  persist();
  return result;
}

function stateAt(cursor) {
  return cursor === 0 ? emptyEDL(project.edl.settings) : project.history[cursor - 1].state;
}

function publicAsset(a) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    size: a.size,
    status: a.status,
    stages: a.stages,
    url: `/api/uploads/${encodeURIComponent(a.filename)}`,
    proxyUrl: a.analysis?.proxy ? `/api/cache/${a.analysis.proxy}` : null,
    analysis: a.analysis ? {
      meta: a.analysis.meta,
      scenes: a.analysis.scenes,
      bpm: a.analysis.beats?.bpm ?? null,
      beats: a.analysis.beats?.beats ?? [],
      peaks: a.analysis.peaks,
      silence: a.analysis.silence,
      tags: a.analysis.tags,
      highlight: a.analysis.highlight,
      hasTranscript: Boolean(a.analysis.transcript),
      transcriptPreview: a.analysis.transcript?.text?.slice(0, 200) ?? null
    } : null
  };
}

function projectPayload() {
  return {
    edl: project.edl,
    duration: edlDuration(project.edl),
    cursor: project.cursor,
    historyLength: project.history.length,
    history: project.history.map(h => ({ id: h.id, op: h.op, summary: h.summary, source: h.source, ts: h.ts })),
    assets: Object.values(project.assets).map(publicAsset),
    capabilities: { whisper: whisperAvailable() }
  };
}

// ---------------------------------------------------------------------------
// Uploads + analysis

function ingestFile(filename, originalName, size) {
  const asset = {
    id: filename,
    filename,
    name: originalName,
    type: assetType(originalName),
    size,
    status: 'analyzing',
    stages: [],
    analysis: null
  };
  project.assets[asset.id] = asset;
  analyzeAsset({
    filePath: path.join(UPLOADS_DIR, filename),
    cacheDir: CACHE_DIR,
    onUpdate: stage => {
      asset.stages = [...asset.stages, stage];
      persist();
    }
  }).then(analysis => {
    asset.analysis = analysis;
    asset.status = 'ready';
    persist();
  }).catch(err => {
    console.error('analysis failed:', err);
    asset.status = 'error';
    persist();
  });
  persist();
  return asset;
}

app.post('/api/upload', upload.array('files'), (req, res) => {
  const files = req.files || [];
  const created = files.map(f => ingestFile(f.filename, f.originalname, f.size));
  res.json({ assets: created.map(publicAsset) });
});

// Import a file already on this machine (used by the MCP server / Claude Code).
app.post('/api/import-path', async (req, res) => {
  const srcPath = String(req.body?.path || '');
  try {
    const stat = await fs.stat(srcPath);
    if (!stat.isFile()) throw new Error('Not a file');
    const originalName = path.basename(srcPath);
    if (assetType(originalName) === 'other') throw new Error(`Unsupported file type: ${originalName}`);
    const safe = originalName.replace(/[^a-zA-Z0-9.\-]/g, '-').replace(/-+/g, '-');
    const filename = `${randomUUID().slice(0, 8)}-${safe}`;
    await fs.copyFile(srcPath, path.join(UPLOADS_DIR, filename));
    const asset = ingestFile(filename, originalName, stat.size);
    res.json({ asset: publicAsset(asset) });
  } catch (err) {
    res.status(400).json({ error: `Cannot import "${srcPath}": ${err.message}` });
  }
});

app.get('/api/assets', (_req, res) => {
  res.json({ assets: Object.values(project.assets).map(publicAsset) });
});

app.delete('/api/assets/:id', (req, res) => {
  const asset = project.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Not found' });
  delete project.assets[req.params.id];
  persist();
  res.json({ ok: true });
});

app.get('/api/uploads/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.resolve(path.join(UPLOADS_DIR, filename));
  if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) return res.status(400).send('Invalid path');
  try {
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch {
    res.status(404).send('Not found');
  }
});

app.get('/api/cache/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.resolve(path.join(CACHE_DIR, filename));
  if (!filePath.startsWith(path.resolve(CACHE_DIR))) return res.status(400).send('Invalid path');
  try {
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch {
    res.status(404).send('Not found');
  }
});

app.get('/api/transcript/:assetId', (req, res) => {
  const asset = project.assets[req.params.assetId];
  if (!asset?.analysis?.transcript) return res.status(404).json({ error: 'No transcript' });
  res.json(asset.analysis.transcript);
});

// ---------------------------------------------------------------------------
// Project + ops

app.get('/api/project', (_req, res) => res.json(projectPayload()));

app.post('/api/project/reset', (_req, res) => {
  project.edl = emptyEDL(project.edl.settings);
  project.history = [];
  project.cursor = 0;
  project.agentMessages = [];
  persist();
  res.json(projectPayload());
});

app.post('/api/ops', (req, res) => {
  const { op, params } = req.body || {};
  try {
    const result = commit(op, params, 'user');
    res.json({ edl: result.state, duration: edlDuration(result.state), diff: result.diff, summary: result.summary, cursor: project.cursor });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/history/seek', (req, res) => {
  const cursor = clamp(Math.round(Number(req.body?.cursor ?? 0)), 0, project.history.length);
  project.cursor = cursor;
  project.edl = stateAt(cursor);
  persist();
  res.json({ edl: project.edl, duration: edlDuration(project.edl), cursor });
});

app.post('/api/undo', (_req, res) => {
  if (project.cursor > 0) {
    project.cursor--;
    project.edl = stateAt(project.cursor);
    persist();
  }
  res.json({ edl: project.edl, duration: edlDuration(project.edl), cursor: project.cursor });
});

app.post('/api/redo', (_req, res) => {
  if (project.cursor < project.history.length) {
    project.cursor++;
    project.edl = stateAt(project.cursor);
    persist();
  }
  res.json({ edl: project.edl, duration: edlDuration(project.edl), cursor: project.cursor });
});

// ---------------------------------------------------------------------------
// Agent: Claude tool-use loop over the op layer, streamed as SSE.

// Media time (in asset) -> timeline time, for every V1/A1 clip of that asset.
function mediaToTimeline(clip, mediaT) {
  const inEnd = clip.in + clip.duration * clip.speed;
  if (mediaT < clip.in || mediaT > inEnd) return null;
  return clip.start + (mediaT - clip.in) / clip.speed;
}

function autoCaptionCues() {
  const v1 = project.edl.tracks.find(t => t.id === 'V1');
  const cues = [];
  for (const clip of v1.clips) {
    const transcript = project.assets[clip.assetId]?.analysis?.transcript;
    if (!transcript) continue;
    for (const cue of groupWordsToCues(transcript.words)) {
      const start = mediaToTimeline(clip, cue.start);
      if (start === null) continue;
      const end = Math.min(clip.start + clip.duration, start + (cue.end - cue.start) / clip.speed);
      cues.push({
        text: cue.text,
        start: Math.round(start * 100) / 100,
        end: Math.round(end * 100) / 100,
        words: cue.words.map(w => ({ w: w.w, start: w.start, end: w.end }))
      });
    }
  }
  return cues;
}

function beatTimesOnTimeline(preferTrack = 'A1') {
  const tracks = preferTrack === 'A1' ? ['A1', 'V1'] : ['V1', 'A1'];
  for (const trackId of tracks) {
    const track = project.edl.tracks.find(t => t.id === trackId);
    const times = [];
    for (const clip of track.clips) {
      const beats = project.assets[clip.assetId]?.analysis?.beats?.beats || [];
      for (const b of beats) {
        const t = mediaToTimeline(clip, b);
        if (t !== null) times.push(Math.round(t * 100) / 100);
      }
    }
    if (times.length) return times.sort((a, b) => a - b);
  }
  return [];
}

const VIRTUAL_TOOLS = [
  {
    name: 'autoCaptions',
    description: 'Generate captions on C1 from the speech transcript of the video clips currently on V1, synced to the timeline. Much better than writing captions by hand.',
    input_schema: {
      type: 'object',
      properties: { style: { type: 'string', enum: ['bold', 'serif', 'karaoke'] } },
      required: []
    },
    run(input) {
      const cues = autoCaptionCues();
      if (!cues.length) throw new Error('No transcript available for clips on V1 (asset may still be analyzing, or has no speech)');
      return commit('addCaptions', { captions: cues, style: input.style || 'bold' }, 'agent');
    }
  },
  {
    name: 'cutOnBeats',
    description: 'Split the clips on a track at the beats of the music (uses the precomputed beat grid of clips on A1, falling back to V1 audio). every=2 cuts every 2nd beat, etc.',
    input_schema: {
      type: 'object',
      properties: {
        trackId: { type: 'string', description: 'Track to cut (default V1)' },
        every: { type: 'number', description: 'Cut every Nth beat (default 2)' },
        minGap: { type: 'number', description: 'Minimum seconds between cuts (default 0.5)' }
      },
      required: []
    },
    run(input) {
      const every = clamp(Math.round(Number(input.every) || 2), 1, 16);
      const minGap = clamp(Number(input.minGap) || 0.5, 0.15, 10);
      const all = beatTimesOnTimeline();
      if (!all.length) throw new Error('No beat grid available — add a music/video clip with detectable beats first');
      const times = [];
      let last = -Infinity;
      all.forEach((t, i) => {
        if (i % every === 0 && t - last >= minGap) { times.push(t); last = t; }
      });
      return commit('splitAt', { trackId: input.trackId || 'V1', times }, 'agent');
    }
  },
  {
    name: 'getTranscript',
    description: 'Read the speech transcript of an asset (with word timestamps in media time). Use to find quotes or moments.',
    input_schema: {
      type: 'object',
      properties: { assetId: { type: 'string' } },
      required: ['assetId']
    },
    run(input) {
      const t = project.assets[input.assetId]?.analysis?.transcript;
      if (!t) throw new Error(`No transcript for "${input.assetId}"`);
      return { info: { text: t.text.slice(0, 6000), cues: groupWordsToCues(t.words).slice(0, 300).map(c => ({ text: c.text, start: c.start, end: c.end })) } };
    }
  }
];

// Direct HTTP access to virtual tools (used by the MCP server).
app.post('/api/tools/:name', (req, res) => {
  const tool = VIRTUAL_TOOLS.find(t => t.name === req.params.name);
  if (!tool) return res.status(404).json({ error: `Unknown tool "${req.params.name}"` });
  try {
    const outcome = tool.run(req.body || {});
    if (outcome.info) return res.json({ info: outcome.info });
    res.json({ summary: outcome.summary, duration: edlDuration(project.edl), cursor: project.cursor });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/describe', (_req, res) => {
  res.json({ assets: describeAssets(), timeline: describeEDL() });
});

// Cheap change-detection endpoint for UI live refresh.
app.get('/api/status', (_req, res) => {
  const assets = Object.values(project.assets);
  res.json({
    cursor: project.cursor,
    historyLength: project.history.length,
    assetCount: assets.length,
    analyzing: assets.filter(a => a.status === 'analyzing').length
  });
});

function describeAssets() {
  const lines = [];
  for (const a of Object.values(project.assets)) {
    if (a.status !== 'ready') { lines.push(`- ${a.id} (${a.type}): ${a.status}`); continue; }
    const m = a.analysis.meta;
    const bits = [`${a.type}`, `${Math.round(m.duration * 10) / 10}s`];
    if (m.width) bits.push(`${m.width}x${m.height}`);
    if (a.analysis.scenes?.length) bits.push(`scene cuts at [${a.analysis.scenes.slice(0, 12).join(', ')}]`);
    if (a.analysis.beats?.bpm) bits.push(`${a.analysis.beats.bpm} BPM (${a.analysis.beats.beats.length} beats)`);
    if (a.analysis.transcript) bits.push(`speech transcript available (${a.analysis.transcript.words.length} words)`);
    if (a.analysis.highlight) bits.push(`suggested highlight ${a.analysis.highlight.start}-${a.analysis.highlight.end}s`);
    if (a.analysis.tags?.length) bits.push(`tags: ${a.analysis.tags.join('/')}`);
    lines.push(`- ${a.id} ("${a.name}"): ${bits.join(', ')}`);
  }
  return lines.length ? lines.join('\n') : '(no assets imported yet)';
}

function describeEDL() {
  const lines = [`Composition: ${project.edl.settings.width}x${project.edl.settings.height} @ ${project.edl.settings.fps}fps, bg ${project.edl.settings.background}, duration ${edlDuration(project.edl)}s`];
  for (const track of project.edl.tracks) {
    if (!track.clips.length) continue;
    if (track.id === 'C1') { lines.push(`C1 (captions): ${track.clips.length} caption cues, style ${track.clips[0]?.style?.caption || 'bold'}`); continue; }
    lines.push(`${track.id}:`);
    for (const c of track.clips.slice(0, 40)) {
      const label = c.type === 'text' ? `text "${(c.text || '').slice(0, 40)}"` : `${c.type} ${c.assetId}`;
      const extras = [];
      if (c.in) extras.push(`in ${c.in}s`);
      if (c.speed !== 1) extras.push(`${c.speed}x`);
      if (c.muted) extras.push('muted');
      else if (c.volume !== 1) extras.push(`vol ${c.volume}`);
      lines.push(`  ${c.id}: ${label} @ ${c.start}s for ${c.duration}s${extras.length ? ` (${extras.join(', ')})` : ''}`);
    }
    if (track.clips.length > 40) lines.push(`  …and ${track.clips.length - 40} more`);
  }
  return lines.join('\n');
}

function agentSystemPrompt() {
  return `You are the editing agent inside ATL Video Editor, a timeline-based video editor. You edit by calling tools that operate on the timeline document. The user sees every tool call you make, and the timeline updates live.

Tracks: V1 (main video/images), O1+O2 (text/title overlays), C1 (captions), A1 (music/audio).

All uploaded assets were pre-analyzed at import: scene cuts, beat grid + BPM, speech transcript with word timings, silence map, and a suggested highlight range. Use these — never guess timings that analysis already provides.

Assets:
${describeAssets()}

Current timeline:
${describeEDL()}

Guidelines:
- Make the requested edits with tool calls, then reply with ONE short sentence summarizing what you did. No markdown.
- Adding footage: addClip with in/duration chosen from the analysis (e.g. use the highlight range for "best part", scene cut boundaries for shot-accurate trims).
- "Cut to the beat" → cutOnBeats. Captions → autoCaptions. "Remove/mute the music" → setTrackVolume on A1.
- Speed ramps: split the clip at the range edges, then setClipProps speed on the middle piece.
- Vertical/TikTok/Reels/Shorts → setSettings 1080x1920.
- If an asset is still analyzing, say so instead of guessing.
- If the request is ambiguous, take the most reasonable interpretation and note it in your reply.`;
}

async function anthropicRequest({ apiKey, model, system, messages, tools }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: model || 'claude-sonnet-5', max_tokens: 4096, system, messages, tools })
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

app.post('/api/agent', async (req, res) => {
  const { message, apiKey: bodyKey, model } = req.body || {};
  const apiKey = bodyKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No Anthropic API key provided' });
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'No message' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const cursorBefore = project.cursor;
  const tools = [...toolDefinitions(), ...VIRTUAL_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }))];
  project.agentMessages.push({ role: 'user', content: message });
  const messages = project.agentMessages.slice(-30);

  try {
    for (let round = 0; round < 16; round++) {
      const response = await anthropicRequest({ apiKey, model, system: agentSystemPrompt(), messages, tools });
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const texts = response.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();

      if (!toolUses.length) {
        if (texts) send('text', { text: texts });
        project.agentMessages = [...messages, { role: 'assistant', content: texts || 'Done.' }];
        break;
      }

      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const tu of toolUses) {
        const virtual = VIRTUAL_TOOLS.find(v => v.name === tu.name);
        try {
          let outcome;
          if (virtual) outcome = virtual.run(tu.input || {});
          else outcome = commit(tu.name, tu.input || {}, 'agent');
          if (outcome.info) {
            send('tool', { name: tu.name, params: tu.input, summary: `Read ${tu.name === 'getTranscript' ? 'transcript' : 'data'}` });
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(outcome.info).slice(0, 24000) });
          } else {
            send('tool', { name: tu.name, params: tu.input, summary: outcome.summary, diff: outcome.diff, edl: project.edl, duration: edlDuration(project.edl), cursor: project.cursor });
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: outcome.summary });
          }
        } catch (err) {
          send('tool', { name: tu.name, params: tu.input, error: err.message });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    send('done', { edl: project.edl, duration: edlDuration(project.edl), cursor: project.cursor, cursorBefore });
  } catch (err) {
    console.error('agent error:', err);
    send('error', { error: err.message });
  }
  persist();
  res.end();
});

app.post('/api/agent/reset', (_req, res) => {
  project.agentMessages = [];
  persist();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Export jobs (hyperframes render)

const jobs = new Map();

function pruneJobs() {
  const cutoff = Date.now() - 1000 * 60 * 60;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff && job.status !== 'rendering') jobs.delete(id);
  }
}

app.post('/api/export', (req, res) => {
  if (edlDuration(project.edl) < 0.2) return res.status(400).json({ error: 'Timeline is empty' });
  pruneJobs();
  const jobId = randomUUID();
  const job = { id: jobId, status: 'queued', progress: 0, stage: 'Queued', result: null, error: null, child: null, cancelled: false, createdAt: Date.now() };
  jobs.set(jobId, job);
  res.json({ jobId });
  const quality = ['draft', 'standard', 'high'].includes(req.body?.quality) ? req.body.quality : 'standard';
  runExportJob(job, quality).catch(err => {
    console.error('export failed:', err);
    job.status = 'error';
    job.error = err.message;
  });
});

async function runExportJob(job, quality) {
  const projectDir = path.join(PROJECTS_DIR, job.id);
  await fs.mkdir(projectDir, { recursive: true });

  job.status = 'rendering';
  job.stage = 'Preparing assets…';
  job.progress = 2;

  const assets = {};
  for (const [id, a] of Object.entries(project.assets)) assets[id] = { filename: a.filename, type: a.type };
  const exportEdl = await prepareExportAssets({ edl: project.edl, assets, uploadsDir: UPLOADS_DIR, projectDir });
  if (job.cancelled) return;

  const html = compileExport({ edl: exportEdl, assets });
  await fs.writeFile(path.join(projectDir, 'index.html'), html, 'utf-8');

  const outputName = 'output.mp4';
  const outputPath = path.join(projectDir, outputName);
  job.stage = 'Rendering…';
  job.progress = 4;

  const args = ['render', '-o', outputName, '-f', String(project.edl.settings.fps), '-q', quality];
  const child = spawn(NODE_EXE, [CLI, ...args], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  job.child = child;

  let stdout = '', stderr = '';
  const progressRe = /(\d{1,3})%\s{2,}(.+)/g;
  child.stdout.on('data', data => {
    const text = data.toString();
    stdout += text;
    let m, last = null;
    while ((m = progressRe.exec(text)) !== null) last = m;
    progressRe.lastIndex = 0;
    if (last) {
      const pct = clamp(Number(last[1]), 0, 100);
      if (pct >= job.progress) { job.progress = pct; job.stage = last[2].trim(); }
    }
  });
  child.stderr.on('data', data => { stderr += data.toString(); });

  await new Promise(resolve => {
    child.on('error', err => {
      job.status = 'error';
      job.error = `Failed to start render: ${err.message}`;
      resolve();
    });
    child.on('close', async code => {
      job.child = null;
      if (job.cancelled) { job.status = 'cancelled'; job.stage = 'Cancelled'; return resolve(); }
      let exists = true;
      try { await fs.access(outputPath); } catch { exists = false; }
      if (code === 0 && exists) {
        const stats = await fs.stat(outputPath);
        job.status = 'done';
        job.progress = 100;
        job.stage = 'Done';
        job.result = {
          jobId: job.id,
          outputUrl: `/api/outputs/${job.id}/${outputName}`,
          outputPath,
          size: stats.size,
          duration: edlDuration(project.edl),
          width: project.edl.settings.width,
          height: project.edl.settings.height
        };
      } else {
        job.status = 'error';
        job.error = (stderr || stdout).split('\n').filter(l => l.trim()).slice(-8).join('\n') || `Render exited ${code}`;
      }
      resolve();
    });
  });
}

app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ jobId: job.id, status: job.status, progress: job.progress, stage: job.stage, result: job.result, error: job.error });
});

app.delete('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (['done', 'error', 'cancelled'].includes(job.status)) return res.json({ jobId: job.id, status: job.status });
  job.cancelled = true;
  if (job.child) {
    try { job.child.kill('SIGTERM'); } catch { /* already gone */ }
  } else {
    job.status = 'cancelled';
  }
  res.json({ jobId: job.id, status: 'cancelling' });
});

app.get('/api/outputs/:jobId/:fileName', async (req, res) => {
  const { jobId, fileName } = req.params;
  const filePath = path.resolve(path.join(PROJECTS_DIR, path.basename(jobId), path.basename(fileName)));
  if (!filePath.startsWith(path.resolve(PROJECTS_DIR))) return res.status(400).send('Invalid path');
  try {
    await fs.access(filePath);
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(filePath);
  } catch {
    res.status(404).send('Not found');
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

await fs.mkdir(PROJECTS_DIR, { recursive: true });
await fs.mkdir(UPLOADS_DIR, { recursive: true });
await fs.mkdir(CACHE_DIR, { recursive: true });
await restore();
app.listen(PORT, () => {
  console.log(`ATL Video Editor server running at http://localhost:${PORT}`);
});

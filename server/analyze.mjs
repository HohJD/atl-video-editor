// Ingest analysis pipeline. Runs at upload time, never at edit time.
// Each analyzer is an isolated (file -> JSON) job; results are cached as
// sidecar JSON keyed by content hash.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fsSync, { createReadStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      fsSync.accessSync(c);
      return c;
    } catch { /* try next */ }
  }
  return null;
}

function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        fsSync.accessSync(full);
        return full;
      } catch { /* try next */ }
    }
  }
  return null;
}

function findWhisper() {
  const isWin = process.platform === 'win32';
  const names = isWin ? ['whisper-cli.exe', 'main.exe'] : ['whisper-cli'];
  return firstExisting([
    process.env.WHISPER_CLI,
    ...(isWin
      ? [
          path.join(process.env.LOCALAPPDATA || '', 'whisper-cpp', 'whisper-cli.exe'),
          'C:\\whisper-cpp\\whisper-cli.exe'
        ]
      : ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'])
  ]) || findOnPath(names);
}

function findWhisperModel() {
  return firstExisting([
    process.env.WHISPER_MODEL,
    path.join(os.homedir(), '.cache', 'atl-models', 'ggml-base.en.bin'),
    ...(process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || '', 'atl-models', 'ggml-base.en.bin'), 'C:\\whisper-cpp\\ggml-base.en.bin']
      : [])
  ]);
}

function run(cmd, args, { timeout = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
    });
  });
}

export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(filePath)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex').slice(0, 16)))
      .on('error', reject);
  });
}

// --- ffprobe metadata ------------------------------------------------------

export async function probe(filePath) {
  const { out } = await run(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const json = JSON.parse(out);
  const video = json.streams?.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = json.streams?.find(s => s.codec_type === 'audio');
  const fpsParts = (video?.avg_frame_rate || '0/1').split('/');
  return {
    duration: Number(json.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0,
    width: video?.width || null,
    height: video?.height || null,
    fps: fpsParts[1] > 0 ? Math.round((fpsParts[0] / fpsParts[1]) * 100) / 100 : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    size: Number(json.format?.size) || 0
  };
}

// --- proxy transcode -------------------------------------------------------

export async function makeProxy(filePath, outPath, meta) {
  if (!meta.hasVideo) return null;
  const scale = meta.height > 720 ? '-2:720' : `${meta.width}:${meta.height}`;
  await run(FFMPEG, [
    '-y', '-i', filePath,
    '-vf', `scale=${scale}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    outPath
  ]);
  return path.basename(outPath);
}

// --- scene detection -------------------------------------------------------

export async function detectScenes(filePath, meta) {
  if (!meta.hasVideo || meta.duration < 1) return [];
  const { err } = await run(FFMPEG, [
    '-i', filePath,
    '-vf', "select='gt(scene,0.3)',showinfo",
    '-f', 'null', '-'
  ]);
  const times = [];
  for (const m of err.matchAll(/pts_time:([\d.]+)/g)) {
    const t = Number(m[1]);
    if (t > 0.2 && (times.length === 0 || t - times[times.length - 1] > 0.4)) times.push(Math.round(t * 100) / 100);
  }
  return times;
}

// --- silence / loudness map ------------------------------------------------

export async function detectSilence(filePath, meta) {
  if (!meta.hasAudio) return { silences: [], speechRanges: [] };
  const { err } = await run(FFMPEG, [
    '-i', filePath,
    '-af', 'silencedetect=noise=-35dB:d=0.4',
    '-f', 'null', '-'
  ]);
  const silences = [];
  let start = null;
  for (const line of err.split('\n')) {
    const s = line.match(/silence_start: ([\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) start = Number(s[1]);
    if (e && start !== null) { silences.push([Math.round(start * 100) / 100, Math.round(Number(e[1]) * 100) / 100]); start = null; }
  }
  if (start !== null) silences.push([Math.round(start * 100) / 100, Math.round(meta.duration * 100) / 100]);
  // Invert to non-silent ("active") ranges
  const active = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    if (s - cursor > 0.3) active.push([Math.round(cursor * 100) / 100, s]);
    cursor = e;
  }
  if (meta.duration - cursor > 0.3) active.push([Math.round(cursor * 100) / 100, Math.round(meta.duration * 100) / 100]);
  return { silences, speechRanges: active };
}

// --- waveform peaks (for timeline drawing) ----------------------------------

export async function waveformPeaks(filePath, meta, buckets = 800) {
  if (!meta.hasAudio) return null;
  const { out } = await runBinary(FFMPEG, [
    '-i', filePath, '-vn',
    '-ac', '1', '-ar', '8000',
    '-f', 's16le', '-'
  ]);
  const samples = new Int16Array(out.buffer, out.byteOffset, Math.floor(out.length / 2));
  if (!samples.length) return null;
  const per = Math.max(1, Math.floor(samples.length / buckets));
  const peaks = [];
  for (let i = 0; i < samples.length; i += per) {
    let max = 0;
    for (let j = i; j < Math.min(i + per, samples.length); j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks.push(Math.round((max / 32768) * 100) / 100);
  }
  return peaks.slice(0, buckets);
}

function runBinary(cmd, args, { timeout = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeout);
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ out: Buffer.concat(chunks) });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`));
    });
  });
}

// --- beat grid ---------------------------------------------------------------
// Energy-flux onset detection + tempo estimate via inter-onset autocorrelation.

export async function detectBeats(filePath, meta) {
  if (!meta.hasAudio || meta.duration < 2) return { bpm: null, beats: [] };
  const SR = 11025;
  const { out } = await runBinary(FFMPEG, ['-i', filePath, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-']);
  const samples = new Int16Array(out.buffer, out.byteOffset, Math.floor(out.length / 2));
  const hop = 512;
  const frames = Math.floor(samples.length / hop);
  if (frames < 20) return { bpm: null, beats: [] };

  // Per-frame energy
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += (samples[i] / 32768) ** 2;
    energy[f] = sum / hop;
  }
  // Positive energy flux
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, energy[f] - energy[f - 1]);

  // Adaptive threshold peak-pick
  const win = Math.round((SR / hop) * 1.0);
  const onsets = [];
  for (let f = 2; f < frames - 2; f++) {
    if (flux[f] <= flux[f - 1] || flux[f] < flux[f + 1]) continue;
    let sum = 0, n = 0;
    for (let k = Math.max(0, f - win); k < Math.min(frames, f + win); k++) { sum += flux[k]; n++; }
    const mean = sum / n;
    if (flux[f] > mean * 2.2 && flux[f] > 1e-5) {
      const t = (f * hop) / SR;
      if (onsets.length === 0 || t - onsets[onsets.length - 1] > 0.18) onsets.push(t);
    }
  }
  if (onsets.length < 4) return { bpm: null, beats: onsets.map(t => Math.round(t * 100) / 100) };

  // Tempo from inter-onset interval histogram
  const iois = [];
  for (let i = 1; i < onsets.length; i++) {
    let d = onsets[i] - onsets[i - 1];
    while (d < 0.28) d *= 2;
    while (d > 1.1) d /= 2;
    iois.push(d);
  }
  iois.sort((a, b) => a - b);
  const median = iois[Math.floor(iois.length / 2)];
  const bpm = Math.round(60 / median);

  // Snap a beat grid to onsets: phase = median onset offset against grid
  const period = 60 / bpm;
  const beats = [];
  let t = onsets[0] % period;
  for (; t < meta.duration; t += period) beats.push(Math.round(t * 100) / 100);
  return { bpm, beats, onsets: onsets.map(t => Math.round(t * 100) / 100) };
}

// --- speech transcription (whisper.cpp) --------------------------------------

export async function transcribe(filePath, meta, workDir) {
  const whisper = findWhisper();
  const model = findWhisperModel();
  if (!meta.hasAudio || !whisper || !model) return null;
  try {
    await fs.access(whisper);
    await fs.access(model);
  } catch {
    return null;
  }

  const wav = path.join(workDir, 'asr-input.wav');
  const outBase = path.join(workDir, 'asr-out');
  await run(FFMPEG, ['-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', wav]);
  try {
    await run(whisper, ['-m', model, '-f', wav, '-oj', '-of', outBase, '-ml', '1', '-sow', '-np'], { timeout: 20 * 60 * 1000 });
    const json = JSON.parse(await fs.readFile(`${outBase}.json`, 'utf-8'));
    const words = [];
    for (const seg of json.transcription || []) {
      const text = (seg.text || '').trim();
      if (!text) continue;
      words.push({
        w: text,
        start: (seg.offsets?.from ?? 0) / 1000,
        end: (seg.offsets?.to ?? 0) / 1000
      });
    }
    const text = words.map(w => w.w).join(' ').replace(/\s+([.,!?])/g, '$1');
    return { text, words, cues: groupWordsToCues(words) };
  } finally {
    await fs.rm(wav, { force: true });
    await fs.rm(`${outBase}.json`, { force: true });
  }
}

// Group word timings into readable caption cues (~4 words / 2.8s max, break on gaps).
export function groupWordsToCues(words, { maxWords = 4, maxDur = 2.8, maxGap = 0.6 } = {}) {
  const cues = [];
  let cur = null;
  for (const w of words) {
    const isPunctEnd = /[.!?]$/.test(w.w);
    if (cur && (
      cur.words.length >= maxWords ||
      w.start - cur.end > maxGap ||
      w.end - cur.start > maxDur
    )) {
      cues.push(cur);
      cur = null;
    }
    if (!cur) cur = { text: '', start: w.start, end: w.end, words: [] };
    cur.text = cur.text ? `${cur.text} ${w.w}` : w.w;
    cur.end = w.end;
    cur.words.push(w);
    if (isPunctEnd) { cues.push(cur); cur = null; }
  }
  if (cur) cues.push(cur);
  return cues.map(c => ({ ...c, text: c.text.replace(/\s+([.,!?])/g, '$1') }));
}

// --- tags + highlight suggestion ---------------------------------------------

export function deriveTags(meta, { transcript, beats, scenes }) {
  const tags = [];
  if (meta.hasVideo) tags.push('video');
  if (!meta.hasVideo && meta.hasAudio) tags.push('audio');
  if (transcript && transcript.words.length > meta.duration * 0.5) tags.push('speech');
  if (beats?.bpm && (!transcript || transcript.words.length < meta.duration * 0.5)) tags.push('music');
  if (scenes?.length > 3) tags.push('multi-scene');
  if (meta.height > meta.width) tags.push('vertical');
  return tags;
}

// Score 10s windows by speech density + audio activity; return the best range.
export function suggestHighlight(meta, { transcript, silence }, windowLen = 10) {
  if (!meta.duration || meta.duration <= windowLen) return null;
  const step = 1;
  let best = { score: -1, start: 0 };
  for (let s = 0; s + windowLen <= meta.duration; s += step) {
    const e = s + windowLen;
    let score = 0;
    if (transcript) {
      score += transcript.words.filter(w => w.start >= s && w.start < e).length;
    }
    if (silence) {
      for (const [as, ae] of silence.speechRanges) {
        score += Math.max(0, Math.min(e, ae) - Math.max(s, as)) * 0.5;
      }
    }
    if (score > best.score) best = { score, start: s };
  }
  if (best.score <= 0) return null;
  return { start: Math.round(best.start * 10) / 10, end: Math.round((best.start + windowLen) * 10) / 10 };
}

// --- orchestrator -------------------------------------------------------------
// Runs all analyzers in parallel; onUpdate(stage) fires as each lands.

export async function analyzeAsset({ filePath, cacheDir, onUpdate = () => {} }) {
  await fs.mkdir(cacheDir, { recursive: true });
  const hash = await hashFile(filePath);
  const sidecarPath = path.join(cacheDir, `${hash}.json`);
  const proxyPath = path.join(cacheDir, `${hash}-proxy.mp4`);

  try {
    const cached = JSON.parse(await fs.readFile(sidecarPath, 'utf-8'));
    onUpdate('cached');
    return cached;
  } catch { /* not cached */ }

  const meta = await probe(filePath);
  onUpdate('metadata');

  const result = { hash, meta, proxy: null, scenes: [], silence: null, peaks: null, beats: null, transcript: null, tags: [], highlight: null };

  const jobs = [
    makeProxy(filePath, proxyPath, meta)
      .then(p => { result.proxy = p; onUpdate('proxy'); })
      .catch(err => console.error('proxy failed:', err.message)),
    detectScenes(filePath, meta)
      .then(s => { result.scenes = s; onUpdate('scenes'); })
      .catch(err => console.error('scenes failed:', err.message)),
    detectSilence(filePath, meta)
      .then(s => { result.silence = s; onUpdate('silence'); })
      .catch(err => console.error('silence failed:', err.message)),
    waveformPeaks(filePath, meta)
      .then(p => { result.peaks = p; onUpdate('waveform'); })
      .catch(err => console.error('waveform failed:', err.message)),
    detectBeats(filePath, meta)
      .then(b => { result.beats = b; onUpdate('beats'); })
      .catch(err => console.error('beats failed:', err.message)),
    transcribe(filePath, meta, cacheDir)
      .then(t => { result.transcript = t; onUpdate('transcript'); })
      .catch(err => console.error('transcribe failed:', err.message))
  ];
  await Promise.all(jobs);

  result.tags = deriveTags(meta, result);
  result.highlight = suggestHighlight(meta, result);
  await fs.writeFile(sidecarPath, JSON.stringify(result), 'utf-8');
  onUpdate('done');
  return result;
}

export function whisperAvailable() {
  return Boolean(findWhisper() && findWhisperModel());
}

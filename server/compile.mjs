// EDL -> HyperFrames composition compiler (export path).
// Preview never touches this; the browser builds its own DOM from the EDL.
// Speed-remapped clips are baked to intermediate assets with ffmpeg first,
// since the renderer has no native playbackRate support.

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { edlDuration } from './edl.mjs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`)));
  });
}

function atempoChain(speed) {
  // atempo supports 0.5-2.0 per instance; chain for wider ranges
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s *= 2; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(',');
}

// Copy source assets and bake speed!=1 clips into normal-speed intermediates.
// Returns a rewritten EDL whose clips all have speed=1 and in-point 0 for baked media.
export async function prepareExportAssets({ edl, assets, uploadsDir, projectDir }) {
  const assetsDir = path.join(projectDir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });
  const out = JSON.parse(JSON.stringify(edl));
  const copied = new Set();

  for (const track of out.tracks) {
    for (const clip of track.clips) {
      if (!clip.assetId) continue;
      const asset = assets[clip.assetId];
      if (!asset) throw new Error(`Missing asset ${clip.assetId}`);
      const src = path.join(uploadsDir, path.basename(asset.filename));

      if (clip.speed !== 1 && (clip.type === 'video' || clip.type === 'audio')) {
        const baked = `baked-${clip.id}${path.extname(asset.filename) || '.mp4'}`;
        const mediaLen = clip.duration * clip.speed;
        const args = ['-y', '-ss', String(clip.in), '-t', String(mediaLen), '-i', src];
        if (clip.type === 'video') {
          args.push('-filter_complex', `[0:v]setpts=PTS/${clip.speed}[v];[0:a]${atempoChain(clip.speed)}[a]`,
            '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac');
        } else {
          args.push('-af', atempoChain(clip.speed), '-c:a', 'aac');
        }
        args.push(path.join(assetsDir, baked));
        await run(FFMPEG, args);
        clip.assetId = baked;
        clip.in = 0;
        clip.speed = 1;
        clip._baked = true;
      } else if (!copied.has(asset.filename)) {
        await fs.copyFile(src, path.join(assetsDir, path.basename(asset.filename)));
        copied.add(asset.filename);
      }
    }
  }
  return out;
}

const CAPTION_CSS = {
  bold: 'font-family:Inter,-apple-system,sans-serif;font-weight:800;text-transform:uppercase;letter-spacing:0.02em;',
  serif: 'font-family:Georgia,\'Times New Roman\',serif;font-weight:600;',
  karaoke: 'font-family:Inter,-apple-system,sans-serif;font-weight:800;'
};

function clipSrc(clip, assets) {
  if (clip._baked) return `assets/${clip.assetId}`;
  const asset = assets[clip.assetId];
  return `assets/${path.basename(asset.filename)}`;
}

export function compileExport({ edl, assets }) {
  const { width, height, fps, background } = edl.settings;
  const duration = Math.max(0.5, edlDuration(edl));
  const gsapCalls = [];
  let body = '';
  let uid = 0;

  const trackIndex = { V1: 0, O1: 2, O2: 3, C1: 4, A1: 9 };

  for (const track of edl.tracks) {
    const z = trackIndex[track.id] ?? 5;
    for (const clip of track.clips) {
      const id = `el${uid++}`;
      const common = `data-start="${clip.start}" data-duration="${clip.duration}" data-track-index="${z}"`;

      if (clip.type === 'video') {
        const vol = clip.muted ? 0 : clip.volume;
        body += `    <video id="${id}" class="clip" src="${esc(clipSrc(clip, assets))}" ${common} data-media-start="${clip.in}" data-volume="${vol}"
      style="position:absolute;inset:0;width:100%;height:100%;object-fit:${clip.fit};"></video>\n`;
      } else if (clip.type === 'image') {
        body += `    <img id="${id}" class="clip" src="${esc(clipSrc(clip, assets))}" ${common}
      style="position:absolute;inset:0;width:100%;height:100%;object-fit:${clip.fit};">\n`;
        gsapCalls.push(`tl.fromTo("#${id}",{opacity:0,scale:1.04},{opacity:1,scale:1,duration:0.5},${clip.start});`);
      } else if (clip.type === 'audio') {
        const vol = clip.muted ? 0 : clip.volume;
        body += `    <audio id="${id}" class="clip" src="${esc(clipSrc(clip, assets))}" ${common} data-media-start="${clip.in}" data-volume="${vol}"></audio>\n`;
      } else if (clip.type === 'text') {
        body += compileText({ id, clip, common, width, height, gsapCalls });
      } else if (clip.type === 'caption') {
        body += compileCaption({ id, clip, common, width, height, gsapCalls });
      }
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"><\/script>
  <script>window.__timelines = window.__timelines || {};<\/script>
</head>
<body>
  <div id="root" data-composition-id="root" data-start="0"
       data-width="${width}" data-height="${height}" data-duration="${duration}"
       style="width:${width}px;height:${height}px;background:${background};position:relative;overflow:hidden;">
${body}  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    ${gsapCalls.join('\n    ')}
    tl.set({}, {}, ${duration});
    window.__timelines["root"] = tl;
  <\/script>
</body>
</html>`;
}

function textPosition(pos, height) {
  if (pos === 'top') return height * 0.08;
  if (pos === 'bottom') return height * 0.78;
  return height * 0.42;
}

function compileText({ id, clip, common, width, height, gsapCalls }) {
  const s = clip.style || {};
  const fontSize = s.fontSize || Math.min(width > height ? 96 : 110, width / 10);
  const color = s.color || '#ffffff';
  const bg = s.bg && s.bg !== 'none' ? `background:${s.bg};padding:0.15em 0.5em;border-radius:0.15em;` : '';
  const family = s.fontFamily || 'Inter, -apple-system, sans-serif';
  const weight = s.weight || 800;
  const top = textPosition(s.position, height);
  const anim = s.animation || 'fade';

  const html = `    <div id="${id}" class="clip" ${common}
      style="position:absolute;left:0;top:${top}px;width:${width}px;text-align:center;pointer-events:none;">
      <span style="display:inline-block;font-family:${esc(family)};font-weight:${weight};font-size:${fontSize}px;color:${color};${bg}text-shadow:0 2px 14px rgba(0,0,0,0.45);max-width:88%;line-height:1.15;">${esc(clip.text || '')}</span>
    </div>\n`;

  const end = clip.start + clip.duration;
  if (anim === 'fade') {
    gsapCalls.push(`tl.fromTo("#${id}",{opacity:0,y:24},{opacity:1,y:0,duration:0.6},${clip.start});`);
  } else if (anim === 'pop') {
    gsapCalls.push(`tl.fromTo("#${id}",{opacity:0,scale:0.6},{opacity:1,scale:1,ease:"back.out(2)",duration:0.5},${clip.start});`);
  } else if (anim === 'slide') {
    gsapCalls.push(`tl.fromTo("#${id}",{opacity:0,x:-80},{opacity:1,x:0,duration:0.5},${clip.start});`);
  }
  if (anim !== 'none' && clip.duration > 1.2) {
    gsapCalls.push(`tl.to("#${id}",{opacity:0,duration:0.4},${Math.max(clip.start, end - 0.4)});`);
  }
  return html;
}

function compileCaption({ id, clip, common, width, height, gsapCalls }) {
  const styleName = clip.style?.caption || 'bold';
  const fontSize = Math.round(Math.min(width, height) * (styleName === 'serif' ? 0.045 : 0.05));
  const base = CAPTION_CSS[styleName] || CAPTION_CSS.bold;

  let inner;
  if (styleName === 'karaoke' && Array.isArray(clip.words) && clip.words.length) {
    inner = clip.words.map((w, i) => `<span id="${id}w${i}" style="color:#ffffff;">${esc(w.w)}</span>`).join(' ');
    clip.words.forEach((w, i) => {
      const t = clip.start + Math.max(0, w.start - (clip.words[0].start ?? 0));
      gsapCalls.push(`tl.to("#${id}w${i}",{color:"#facc15",duration:0.08},${Math.round(t * 100) / 100});`);
    });
  } else {
    inner = esc(clip.text || '');
  }

  return `    <div id="${id}" class="clip" ${common}
      style="position:absolute;left:0;top:${Math.round(height * 0.82)}px;width:${width}px;text-align:center;pointer-events:none;">
      <span style="display:inline-block;${base}font-size:${fontSize}px;color:#ffffff;background:rgba(0,0,0,0.55);padding:0.2em 0.6em;border-radius:0.25em;max-width:86%;line-height:1.25;">${inner}</span>
    </div>\n`;
}

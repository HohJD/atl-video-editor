// EDL document model + pure op layer.
// Every op: (state, params) -> { state, diff, summary }. State is never mutated.
// The ops registry doubles as the tool schema for the AI agent.

import { randomUUID } from 'crypto';

export const TRACKS = [
  { id: 'V1', kind: 'video', label: 'Video' },
  { id: 'O1', kind: 'overlay', label: 'Overlay 1' },
  { id: 'O2', kind: 'overlay', label: 'Overlay 2' },
  { id: 'C1', kind: 'caption', label: 'Captions' },
  { id: 'A1', kind: 'audio', label: 'Audio' }
];

export const CAPTION_STYLES = ['bold', 'serif', 'karaoke'];
export const TEXT_ANIMATIONS = ['fade', 'pop', 'slide', 'none'];

export function emptyEDL({ width = 1920, height = 1080, fps = 30, background = '#0b0c15' } = {}) {
  return {
    version: 1,
    settings: { width, height, fps, background },
    tracks: TRACKS.map(t => ({ id: t.id, kind: t.kind, clips: [] }))
  };
}

export function edlDuration(edl) {
  let end = 0;
  for (const track of edl.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration);
  }
  return Math.round(end * 1000) / 1000;
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function newId(prefix = 'c') {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function findTrack(edl, trackId) {
  const t = edl.tracks.find(t => t.id === trackId);
  if (!t) throw new Error(`Unknown track "${trackId}". Tracks: ${edl.tracks.map(t => t.id).join(', ')}`);
  return t;
}

function findClip(edl, clipId) {
  for (const track of edl.tracks) {
    const clip = track.clips.find(c => c.id === clipId);
    if (clip) return { track, clip };
  }
  throw new Error(`Unknown clip "${clipId}"`);
}

function sortTrack(track) {
  track.clips.sort((a, b) => a.start - b.start);
}

function num(v, name, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number`);
  if (n < min || n > max) throw new Error(`"${name}" must be between ${min} and ${max}`);
  return n;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function makeClip(base) {
  return {
    id: newId(),
    type: base.type,
    assetId: base.assetId ?? null,
    start: round(base.start ?? 0),
    duration: round(base.duration ?? 3),
    in: round(base.in ?? 0),
    speed: base.speed ?? 1,
    volume: base.volume ?? 1,
    muted: base.muted ?? false,
    fit: base.fit ?? 'cover',
    text: base.text ?? null,
    words: base.words ?? null,
    style: base.style ?? null
  };
}

// ---------------------------------------------------------------------------
// Ops. Each entry: { description, params (JSON schema properties), required, apply }.

export const OPS = {
  addClip: {
    description: 'Add a media clip (video/image/audio) from an imported asset to a track. For video/audio, "in" is the trim offset into the source media in seconds.',
    params: {
      trackId: { type: 'string', description: 'V1 for video/images, A1 for audio/music' },
      assetId: { type: 'string', description: 'ID of an imported asset' },
      start: { type: 'number', description: 'Timeline position in seconds' },
      duration: { type: 'number', description: 'Clip duration in seconds' },
      in: { type: 'number', description: 'Trim offset into source media (seconds, default 0)' },
      fit: { type: 'string', enum: ['cover', 'contain'] }
    },
    required: ['trackId', 'assetId', 'start', 'duration'],
    apply(state, p, ctx = {}) {
      const edl = clone(state);
      const track = findTrack(edl, p.trackId);
      const asset = ctx.assets?.[p.assetId];
      if (ctx.assets && !asset) throw new Error(`Unknown asset "${p.assetId}"`);
      const type = asset?.type || (track.kind === 'audio' ? 'audio' : 'video');
      if (track.kind === 'audio' && type !== 'audio') throw new Error('Only audio assets can go on A1');
      if (track.kind === 'caption') throw new Error('Use addCaptions for the caption track');
      const clip = makeClip({
        type,
        assetId: p.assetId,
        start: num(p.start, 'start', { min: 0 }),
        duration: num(p.duration, 'duration', { min: 0.05 }),
        in: p.in !== undefined ? num(p.in, 'in', { min: 0 }) : 0,
        fit: p.fit
      });
      track.clips.push(clip);
      sortTrack(track);
      return {
        state: edl,
        diff: { added: [clip.id], removed: [], changed: [] },
        summary: `Added ${type} "${p.assetId}" to ${p.trackId} at ${fmtTime(clip.start)} (${clip.duration}s)`
      };
    }
  },

  addText: {
    description: 'Add a text/title overlay. Style controls appearance and entrance animation.',
    params: {
      text: { type: 'string' },
      start: { type: 'number' },
      duration: { type: 'number' },
      trackId: { type: 'string', description: 'O1 or O2 (default O1)' },
      style: {
        type: 'object',
        description: 'Optional: { fontSize (px), color (hex), bg (hex or "none"), fontFamily, weight (400-900), position ("top"|"center"|"bottom"), animation ("fade"|"pop"|"slide"|"none") }',
        properties: {}
      }
    },
    required: ['text', 'start', 'duration'],
    apply(state, p) {
      const edl = clone(state);
      const trackId = p.trackId || 'O1';
      const track = findTrack(edl, trackId);
      if (track.kind !== 'overlay') throw new Error('Text goes on overlay tracks (O1/O2)');
      const clip = makeClip({
        type: 'text',
        text: String(p.text).slice(0, 300),
        start: num(p.start, 'start', { min: 0 }),
        duration: num(p.duration, 'duration', { min: 0.05 }),
        style: sanitizeStyle(p.style)
      });
      track.clips.push(clip);
      sortTrack(track);
      return {
        state: edl,
        diff: { added: [clip.id], removed: [], changed: [] },
        summary: `Added title "${clip.text.slice(0, 40)}" at ${fmtTime(clip.start)}`
      };
    }
  },

  addCaptions: {
    description: 'Replace the caption track with caption cues (usually from the transcript). Each cue: { text, start, end, words? }.',
    params: {
      captions: { type: 'array', items: { type: 'object', properties: {} }, description: '[{ text, start, end }]' },
      style: { type: 'string', enum: CAPTION_STYLES, description: 'bold | serif | karaoke' }
    },
    required: ['captions'],
    apply(state, p) {
      const edl = clone(state);
      const track = findTrack(edl, 'C1');
      track.clips = [];
      const styleName = CAPTION_STYLES.includes(p.style) ? p.style : 'bold';
      for (const cue of p.captions) {
        if (typeof cue.text !== 'string' || !Number.isFinite(Number(cue.start)) || !Number.isFinite(Number(cue.end))) continue;
        const start = round(Math.max(0, Number(cue.start)));
        const dur = round(Math.max(0.1, Number(cue.end) - Number(cue.start)));
        track.clips.push(makeClip({
          type: 'caption',
          text: cue.text.slice(0, 200),
          words: Array.isArray(cue.words) ? cue.words : null,
          start,
          duration: dur,
          style: { caption: styleName }
        }));
      }
      sortTrack(track);
      return {
        state: edl,
        diff: { added: track.clips.map(c => c.id), removed: [], changed: [] },
        summary: `Added ${track.clips.length} ${styleName} captions`
      };
    }
  },

  setCaptionStyle: {
    description: 'Change the style of all captions.',
    params: { style: { type: 'string', enum: CAPTION_STYLES } },
    required: ['style'],
    apply(state, p) {
      if (!CAPTION_STYLES.includes(p.style)) throw new Error(`style must be one of ${CAPTION_STYLES.join(', ')}`);
      const edl = clone(state);
      const track = findTrack(edl, 'C1');
      for (const c of track.clips) c.style = { ...(c.style || {}), caption: p.style };
      return {
        state: edl,
        diff: { added: [], removed: [], changed: track.clips.map(c => c.id) },
        summary: `Caption style → ${p.style}`
      };
    }
  },

  deleteClip: {
    description: 'Delete a clip from the timeline (leaves a gap).',
    params: { clipId: { type: 'string' } },
    required: ['clipId'],
    apply(state, p) {
      const edl = clone(state);
      const { track, clip } = findClip(edl, p.clipId);
      track.clips = track.clips.filter(c => c.id !== clip.id);
      return {
        state: edl,
        diff: { added: [], removed: [clip.id], changed: [] },
        summary: `Deleted clip at ${fmtTime(clip.start)} on ${track.id}`
      };
    }
  },

  rippleDelete: {
    description: 'Delete a clip and shift all later clips on the same track left to close the gap.',
    params: { clipId: { type: 'string' } },
    required: ['clipId'],
    apply(state, p) {
      const edl = clone(state);
      const { track, clip } = findClip(edl, p.clipId);
      track.clips = track.clips.filter(c => c.id !== clip.id);
      const changed = [];
      for (const c of track.clips) {
        if (c.start > clip.start) {
          c.start = round(Math.max(0, c.start - clip.duration));
          changed.push(c.id);
        }
      }
      return {
        state: edl,
        diff: { added: [], removed: [clip.id], changed },
        summary: `Ripple-deleted clip on ${track.id}, closed ${clip.duration}s gap`
      };
    }
  },

  splitClip: {
    description: 'Split a clip into two at a timeline position (seconds).',
    params: { clipId: { type: 'string' }, at: { type: 'number', description: 'Timeline time in seconds' } },
    required: ['clipId', 'at'],
    apply(state, p) {
      const edl = clone(state);
      const { track, clip } = findClip(edl, p.clipId);
      const at = num(p.at, 'at');
      if (at <= clip.start + 0.05 || at >= clip.start + clip.duration - 0.05) {
        throw new Error(`Split point ${at}s is outside clip range ${clip.start}–${round(clip.start + clip.duration)}s`);
      }
      const offset = at - clip.start;
      const second = makeClip({ ...clip, start: at, duration: clip.duration - offset, in: clip.in + offset * clip.speed });
      clip.duration = round(offset);
      track.clips.push(second);
      sortTrack(track);
      return {
        state: edl,
        diff: { added: [second.id], removed: [], changed: [clip.id] },
        summary: `Split clip at ${fmtTime(at)}`
      };
    }
  },

  splitAt: {
    description: 'Split whatever clips on a track intersect each of the given timeline times. Used for beat-cutting and scene cuts.',
    params: {
      trackId: { type: 'string' },
      times: { type: 'array', items: { type: 'number' }, description: 'Timeline times in seconds' }
    },
    required: ['trackId', 'times'],
    apply(state, p) {
      let edl = clone(state);
      const track = findTrack(edl, p.trackId);
      const added = [];
      const changed = new Set();
      const times = [...p.times].map(t => num(t, 'time')).sort((a, b) => a - b);
      let count = 0;
      for (const t of times) {
        const target = track.clips.find(c => t > c.start + 0.05 && t < c.start + c.duration - 0.05);
        if (!target) continue;
        const offset = t - target.start;
        const second = makeClip({ ...target, start: t, duration: target.duration - offset, in: target.in + offset * target.speed });
        target.duration = round(offset);
        track.clips.push(second);
        sortTrack(track);
        added.push(second.id);
        changed.add(target.id);
        count++;
      }
      return {
        state: edl,
        diff: { added, removed: [], changed: [...changed] },
        summary: `Placed ${count} cuts on ${p.trackId}`
      };
    }
  },

  trimClip: {
    description: 'Adjust clip edges. newStart/newEnd are timeline times; the media in-point follows the left edge (slip-aware trim).',
    params: {
      clipId: { type: 'string' },
      newStart: { type: 'number' },
      newEnd: { type: 'number' }
    },
    required: ['clipId'],
    apply(state, p) {
      const edl = clone(state);
      const { clip } = findClip(edl, p.clipId);
      const oldEnd = clip.start + clip.duration;
      if (p.newStart !== undefined) {
        const ns = num(p.newStart, 'newStart', { min: 0, max: oldEnd - 0.05 });
        clip.in = round(Math.max(0, clip.in + (ns - clip.start) * clip.speed));
        clip.duration = round(oldEnd - ns);
        clip.start = round(ns);
      }
      if (p.newEnd !== undefined) {
        const ne = num(p.newEnd, 'newEnd', { min: clip.start + 0.05 });
        clip.duration = round(ne - clip.start);
      }
      return {
        state: edl,
        diff: { added: [], removed: [], changed: [clip.id] },
        summary: `Trimmed clip to ${fmtTime(clip.start)}–${fmtTime(clip.start + clip.duration)}`
      };
    }
  },

  slipClip: {
    description: 'Slip the media inside a clip without moving it on the timeline (changes the in-point).',
    params: { clipId: { type: 'string' }, by: { type: 'number', description: 'Seconds to slip the media (+/-)' } },
    required: ['clipId', 'by'],
    apply(state, p) {
      const edl = clone(state);
      const { clip } = findClip(edl, p.clipId);
      clip.in = round(Math.max(0, clip.in + num(p.by, 'by')));
      return {
        state: edl,
        diff: { added: [], removed: [], changed: [clip.id] },
        summary: `Slipped media by ${p.by}s`
      };
    }
  },

  moveClip: {
    description: 'Move a clip to a new timeline position and optionally a different track.',
    params: {
      clipId: { type: 'string' },
      start: { type: 'number' },
      trackId: { type: 'string' }
    },
    required: ['clipId', 'start'],
    apply(state, p) {
      const edl = clone(state);
      const { track, clip } = findClip(edl, p.clipId);
      clip.start = round(num(p.start, 'start', { min: 0 }));
      if (p.trackId && p.trackId !== track.id) {
        const dest = findTrack(edl, p.trackId);
        if (dest.kind !== track.kind) throw new Error(`Cannot move a ${track.kind} clip to a ${dest.kind} track`);
        track.clips = track.clips.filter(c => c.id !== clip.id);
        dest.clips.push(clip);
        sortTrack(dest);
      } else {
        sortTrack(track);
      }
      return {
        state: edl,
        diff: { added: [], removed: [], changed: [clip.id] },
        summary: `Moved clip to ${fmtTime(clip.start)}${p.trackId ? ` on ${p.trackId}` : ''}`
      };
    }
  },

  cloneClip: {
    description: 'Duplicate a clip. The copy is placed right after the original unless start is given.',
    params: { clipId: { type: 'string' }, start: { type: 'number' } },
    required: ['clipId'],
    apply(state, p) {
      const edl = clone(state);
      const { track, clip } = findClip(edl, p.clipId);
      const copy = makeClip({ ...clip, start: p.start !== undefined ? num(p.start, 'start', { min: 0 }) : clip.start + clip.duration });
      track.clips.push(copy);
      sortTrack(track);
      return {
        state: edl,
        diff: { added: [copy.id], removed: [], changed: [] },
        summary: `Cloned clip to ${fmtTime(copy.start)}`
      };
    }
  },

  setClipProps: {
    description: 'Set clip properties: volume (0-1), muted, speed (0.25-4, time remap), fit, text, style.',
    params: {
      clipId: { type: 'string' },
      volume: { type: 'number' },
      muted: { type: 'boolean' },
      speed: { type: 'number', description: 'Playback speed; 0.5 = slow motion, 2 = 2x. Timeline duration rescales to keep the same media range.' },
      fit: { type: 'string', enum: ['cover', 'contain'] },
      text: { type: 'string' },
      style: { type: 'object', properties: {} }
    },
    required: ['clipId'],
    apply(state, p) {
      const edl = clone(state);
      const { clip } = findClip(edl, p.clipId);
      const notes = [];
      if (p.volume !== undefined) { clip.volume = num(p.volume, 'volume', { min: 0, max: 1 }); notes.push(`volume ${clip.volume}`); }
      if (p.muted !== undefined) { clip.muted = Boolean(p.muted); notes.push(clip.muted ? 'muted' : 'unmuted'); }
      if (p.speed !== undefined) {
        const speed = num(p.speed, 'speed', { min: 0.25, max: 4 });
        const mediaLen = clip.duration * clip.speed;
        clip.speed = speed;
        clip.duration = round(mediaLen / speed);
        notes.push(`speed ${speed}x`);
      }
      if (p.fit !== undefined) { clip.fit = p.fit === 'contain' ? 'contain' : 'cover'; notes.push(`fit ${clip.fit}`); }
      if (p.text !== undefined && (clip.type === 'text' || clip.type === 'caption')) { clip.text = String(p.text).slice(0, 300); notes.push('text updated'); }
      if (p.style !== undefined) { clip.style = { ...(clip.style || {}), ...sanitizeStyle(p.style) }; notes.push('style updated'); }
      return {
        state: edl,
        diff: { added: [], removed: [], changed: [clip.id] },
        summary: notes.length ? `Clip: ${notes.join(', ')}` : 'No changes'
      };
    }
  },

  setTrackVolume: {
    description: 'Set volume/mute for every clip on a track. Use A1 muted=true to remove background music.',
    params: {
      trackId: { type: 'string' },
      volume: { type: 'number' },
      muted: { type: 'boolean' }
    },
    required: ['trackId'],
    apply(state, p) {
      const edl = clone(state);
      const track = findTrack(edl, p.trackId);
      for (const c of track.clips) {
        if (p.volume !== undefined) c.volume = num(p.volume, 'volume', { min: 0, max: 1 });
        if (p.muted !== undefined) c.muted = Boolean(p.muted);
      }
      return {
        state: edl,
        diff: { added: [], removed: [], changed: track.clips.map(c => c.id) },
        summary: `${track.id}: ${p.muted !== undefined ? (p.muted ? 'muted' : 'unmuted') : ''} ${p.volume !== undefined ? `volume ${p.volume}` : ''}`.trim()
      };
    }
  },

  trimToRange: {
    description: 'Keep only the timeline range [start, end] and shift everything to begin at 0. Used for "keep the best N seconds".',
    params: { start: { type: 'number' }, end: { type: 'number' } },
    required: ['start', 'end'],
    apply(state, p) {
      const edl = clone(state);
      const start = num(p.start, 'start', { min: 0 });
      const end = num(p.end, 'end', { min: start + 0.1 });
      const changed = [];
      const removed = [];
      for (const track of edl.tracks) {
        const kept = [];
        for (const clip of track.clips) {
          const cEnd = clip.start + clip.duration;
          if (cEnd <= start || clip.start >= end) { removed.push(clip.id); continue; }
          if (clip.start < start) {
            clip.in = round(clip.in + (start - clip.start) * clip.speed);
            clip.duration = round(cEnd - start);
            clip.start = start;
          }
          if (clip.start + clip.duration > end) clip.duration = round(end - clip.start);
          clip.start = round(clip.start - start);
          changed.push(clip.id);
          kept.push(clip);
        }
        track.clips = kept;
      }
      return {
        state: edl,
        diff: { added: [], removed, changed },
        summary: `Trimmed timeline to ${fmtTime(start)}–${fmtTime(end)} (${round(end - start)}s)`
      };
    }
  },

  clearTrack: {
    description: 'Remove all clips from a track.',
    params: { trackId: { type: 'string' } },
    required: ['trackId'],
    apply(state, p) {
      const edl = clone(state);
      const track = findTrack(edl, p.trackId);
      const removed = track.clips.map(c => c.id);
      track.clips = [];
      return { state: edl, diff: { added: [], removed, changed: [] }, summary: `Cleared ${track.id}` };
    }
  },

  packTrack: {
    description: 'Close all gaps on a track so clips play back-to-back.',
    params: { trackId: { type: 'string' } },
    required: ['trackId'],
    apply(state, p) {
      const edl = clone(state);
      const track = findTrack(edl, p.trackId);
      sortTrack(track);
      let cursor = 0;
      const changed = [];
      for (const clip of track.clips) {
        if (clip.start !== cursor) { clip.start = round(cursor); changed.push(clip.id); }
        cursor = clip.start + clip.duration;
      }
      return { state: edl, diff: { added: [], removed: [], changed }, summary: `Packed ${track.id} (${track.clips.length} clips)` };
    }
  },

  setSettings: {
    description: 'Change composition settings: width, height, fps (24/30/60), background color. 1080x1920 for TikTok/Reels/Shorts.',
    params: {
      width: { type: 'number' },
      height: { type: 'number' },
      fps: { type: 'number', enum: [24, 30, 60] },
      background: { type: 'string' }
    },
    required: [],
    apply(state, p) {
      const edl = clone(state);
      if (p.width !== undefined) edl.settings.width = Math.round(num(p.width, 'width', { min: 64, max: 3840 }));
      if (p.height !== undefined) edl.settings.height = Math.round(num(p.height, 'height', { min: 64, max: 3840 }));
      if (p.fps !== undefined) {
        if (![24, 30, 60].includes(Number(p.fps))) throw new Error('fps must be 24, 30 or 60');
        edl.settings.fps = Number(p.fps);
      }
      if (p.background !== undefined) {
        if (!/^#([0-9A-Fa-f]{3}){1,2}$/.test(p.background)) throw new Error('background must be a hex color');
        edl.settings.background = p.background;
      }
      return {
        state: edl,
        diff: { added: [], removed: [], changed: [] },
        summary: `Settings → ${edl.settings.width}x${edl.settings.height} @ ${edl.settings.fps}fps`
      };
    }
  }
};

function sanitizeStyle(style) {
  if (!style || typeof style !== 'object') return null;
  const out = {};
  if (Number.isFinite(Number(style.fontSize))) out.fontSize = Math.min(400, Math.max(8, Number(style.fontSize)));
  if (typeof style.color === 'string' && /^#([0-9A-Fa-f]{3}){1,2}$/.test(style.color)) out.color = style.color;
  if (typeof style.bg === 'string' && (/^#([0-9A-Fa-f]{3}){1,2}$/.test(style.bg) || style.bg === 'none')) out.bg = style.bg;
  if (typeof style.fontFamily === 'string') out.fontFamily = style.fontFamily.slice(0, 60).replace(/[^a-zA-Z0-9 ,'-]/g, '');
  if (Number.isFinite(Number(style.weight))) out.weight = Math.min(900, Math.max(100, Math.round(Number(style.weight) / 100) * 100));
  if (['top', 'center', 'bottom'].includes(style.position)) out.position = style.position;
  if (TEXT_ANIMATIONS.includes(style.animation)) out.animation = style.animation;
  if (CAPTION_STYLES.includes(style.caption)) out.caption = style.caption;
  return Object.keys(out).length ? out : null;
}

export function applyOp(state, opName, params, ctx) {
  const op = OPS[opName];
  if (!op) throw new Error(`Unknown op "${opName}"`);
  return op.apply(state, params || {}, ctx);
}

// Anthropic tool definitions generated from the ops registry.
export function toolDefinitions() {
  return Object.entries(OPS).map(([name, op]) => ({
    name,
    description: op.description,
    input_schema: {
      type: 'object',
      properties: op.params,
      required: op.required
    }
  }));
}

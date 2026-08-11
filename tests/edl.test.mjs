import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyEDL, applyOp, edlDuration, toolDefinitions, OPS } from '../server/edl.mjs';

const ASSETS = {
  'clip.mp4': { type: 'video', duration: 30 },
  'photo.jpg': { type: 'image' },
  'song.mp3': { type: 'audio', duration: 120 }
};

function baseState() {
  let s = emptyEDL();
  s = applyOp(s, 'addClip', { trackId: 'V1', assetId: 'clip.mp4', start: 0, duration: 10 }, { assets: ASSETS }).state;
  return s;
}

function v1(s) {
  return s.tracks.find(t => t.id === 'V1').clips;
}

test('ops are pure — input state is never mutated', () => {
  const s = baseState();
  const frozen = JSON.stringify(s);
  applyOp(s, 'splitClip', { clipId: v1(s)[0].id, at: 5 });
  applyOp(s, 'deleteClip', { clipId: v1(s)[0].id });
  applyOp(s, 'setSettings', { width: 1080, height: 1920 });
  assert.equal(JSON.stringify(s), frozen);
});

test('addClip validates track kind and asset', () => {
  const s = emptyEDL();
  assert.throws(() => applyOp(s, 'addClip', { trackId: 'A1', assetId: 'clip.mp4', start: 0, duration: 5 }, { assets: ASSETS }), /audio/);
  assert.throws(() => applyOp(s, 'addClip', { trackId: 'V1', assetId: 'nope.mp4', start: 0, duration: 5 }, { assets: ASSETS }), /Unknown asset/);
  assert.throws(() => applyOp(s, 'addClip', { trackId: 'ZZ', assetId: 'clip.mp4', start: 0, duration: 5 }, { assets: ASSETS }), /Unknown track/);
});

test('splitClip produces two clips with continuous media range', () => {
  const s = baseState();
  const { state, diff } = applyOp(s, 'splitClip', { clipId: v1(s)[0].id, at: 4 });
  const clips = v1(state);
  assert.equal(clips.length, 2);
  assert.equal(clips[0].duration, 4);
  assert.equal(clips[1].start, 4);
  assert.equal(clips[1].duration, 6);
  assert.equal(clips[1].in, 4);
  assert.equal(diff.added.length, 1);
});

test('splitClip respects speed for in-point math', () => {
  let s = baseState();
  s = applyOp(s, 'setClipProps', { clipId: v1(s)[0].id, speed: 2 }).state; // 10s media at 2x -> 5s timeline
  assert.equal(v1(s)[0].duration, 5);
  const { state } = applyOp(s, 'splitClip', { clipId: v1(s)[0].id, at: 2 });
  assert.equal(v1(state)[1].in, 4); // 2s timeline * 2x speed = 4s into media
});

test('splitAt places multiple cuts, skipping out-of-range times', () => {
  const s = baseState();
  const { state, summary } = applyOp(s, 'splitAt', { trackId: 'V1', times: [2, 5, 8, 100] });
  assert.equal(v1(state).length, 4);
  assert.match(summary, /3 cuts/);
});

test('rippleDelete closes the gap', () => {
  let s = baseState();
  s = applyOp(s, 'splitAt', { trackId: 'V1', times: [3, 6] }).state;
  const middle = v1(s)[1];
  const { state } = applyOp(s, 'rippleDelete', { clipId: middle.id });
  const clips = v1(state);
  assert.equal(clips.length, 2);
  assert.equal(clips[1].start, 3);
  assert.equal(edlDuration(state), 7);
});

test('trimClip keeps media in-point aligned with left edge', () => {
  const s = baseState();
  const { state } = applyOp(s, 'trimClip', { clipId: v1(s)[0].id, newStart: 2, newEnd: 8 });
  const c = v1(state)[0];
  assert.equal(c.start, 2);
  assert.equal(c.duration, 6);
  assert.equal(c.in, 2);
});

test('trimToRange shifts and clips everything', () => {
  let s = baseState();
  s = applyOp(s, 'addText', { text: 'Title', start: 1, duration: 9 }).state;
  const { state } = applyOp(s, 'trimToRange', { start: 2, end: 7 });
  assert.equal(edlDuration(state), 5);
  const video = v1(state)[0];
  assert.equal(video.start, 0);
  assert.equal(video.in, 2);
  const text = state.tracks.find(t => t.id === 'O1').clips[0];
  assert.equal(text.start, 0); // was at 1, range starts at 2 -> clipped to range start
});

test('setClipProps speed rescales duration to keep media range', () => {
  const s = baseState();
  const { state } = applyOp(s, 'setClipProps', { clipId: v1(s)[0].id, speed: 0.5 });
  assert.equal(v1(state)[0].duration, 20);
});

test('setTrackVolume mutes all audio (remove background music)', () => {
  let s = baseState();
  s = applyOp(s, 'addClip', { trackId: 'A1', assetId: 'song.mp3', start: 0, duration: 10 }, { assets: ASSETS }).state;
  const { state } = applyOp(s, 'setTrackVolume', { trackId: 'A1', muted: true });
  assert.ok(state.tracks.find(t => t.id === 'A1').clips.every(c => c.muted));
});

test('addCaptions replaces caption track and setCaptionStyle restyles', () => {
  let s = baseState();
  s = applyOp(s, 'addCaptions', {
    captions: [
      { text: 'hello world', start: 0, end: 1.5 },
      { text: 'second cue', start: 1.5, end: 3 },
      { text: 'bad cue', start: 'x', end: 2 }
    ],
    style: 'bold'
  }).state;
  const track = s.tracks.find(t => t.id === 'C1');
  assert.equal(track.clips.length, 2);
  const { state } = applyOp(s, 'setCaptionStyle', { style: 'karaoke' });
  assert.ok(state.tracks.find(t => t.id === 'C1').clips.every(c => c.style.caption === 'karaoke'));
});

test('packTrack closes gaps', () => {
  let s = baseState();
  s = applyOp(s, 'splitAt', { trackId: 'V1', times: [3, 6] }).state;
  s = applyOp(s, 'deleteClip', { clipId: v1(s)[1].id }).state;
  const { state } = applyOp(s, 'packTrack', { trackId: 'V1' });
  const clips = v1(state);
  assert.equal(clips[1].start, 3);
});

test('moveClip rejects cross-kind moves', () => {
  const s = baseState();
  assert.throws(() => applyOp(s, 'moveClip', { clipId: v1(s)[0].id, start: 0, trackId: 'A1' }), /Cannot move/);
});

test('every op has a valid Anthropic tool definition', () => {
  const defs = toolDefinitions();
  assert.equal(defs.length, Object.keys(OPS).length);
  for (const d of defs) {
    assert.ok(d.name && d.description);
    assert.equal(d.input_schema.type, 'object');
    assert.ok(Array.isArray(d.input_schema.required));
  }
});

test('cloneClip appends after original by default', () => {
  const s = baseState();
  const { state } = applyOp(s, 'cloneClip', { clipId: v1(s)[0].id });
  assert.equal(v1(state).length, 2);
  assert.equal(v1(state)[1].start, 10);
});

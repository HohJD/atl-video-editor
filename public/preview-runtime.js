// Browser-side preview compositor. Builds DOM from the EDL and plays/scrubs it
// entirely client-side against proxy media. Mirrors server/compile.mjs layout math.

(() => {
  const comp = document.getElementById('comp');
  const stage = document.getElementById('stage');

  const state = {
    edl: null,
    urls: {},
    duration: 0,
    time: 0,
    playing: false,
    lastTick: 0,
    els: new Map() // clipId -> { root, media, clip, words }
  };

  const CAPTION_FONTS = {
    bold: "font-family:Inter,-apple-system,sans-serif;font-weight:800;text-transform:uppercase;letter-spacing:0.02em;",
    serif: "font-family:Georgia,'Times New Roman',serif;font-weight:600;",
    karaoke: "font-family:Inter,-apple-system,sans-serif;font-weight:800;"
  };

  function fitStage() {
    if (!state.edl) return;
    const { width, height } = state.edl.settings;
    const scale = Math.min(stage.clientWidth / width, stage.clientHeight / height);
    comp.style.width = width + 'px';
    comp.style.height = height + 'px';
    comp.style.transform = `scale(${scale})`;
  }
  window.addEventListener('resize', fitStage);

  function textPosition(pos, height) {
    if (pos === 'top') return height * 0.08;
    if (pos === 'bottom') return height * 0.78;
    return height * 0.42;
  }

  function buildClipEl(clip, track) {
    const { width, height } = state.edl.settings;
    const root = document.createElement('div');
    root.className = 'pv-clip';
    root.style.zIndex = { V1: 0, O1: 2, O2: 3, C1: 4, A1: 0 }[track.id] ?? 1;
    let media = null;
    let words = null;

    if (clip.type === 'video' || clip.type === 'audio') {
      media = document.createElement(clip.type === 'video' ? 'video' : 'audio');
      media.src = state.urls[clip.assetId] || '';
      media.preload = 'auto';
      media.playsInline = true;
      media.crossOrigin = 'anonymous';
      if (clip.type === 'video') {
        media.className = 'pv-media';
        media.style.position = 'absolute';
        media.style.objectFit = clip.fit;
        root.style.inset = '0';
      }
      root.appendChild(media);
    } else if (clip.type === 'image') {
      media = document.createElement('img');
      media.src = state.urls[clip.assetId] || '';
      media.className = 'pv-media';
      media.style.position = 'absolute';
      media.style.objectFit = clip.fit;
      root.style.inset = '0';
      root.appendChild(media);
    } else if (clip.type === 'text') {
      const s = clip.style || {};
      const fontSize = s.fontSize || Math.min(width > height ? 96 : 110, width / 10);
      root.className = 'pv-clip pv-textwrap';
      root.style.top = textPosition(s.position, height) + 'px';
      const span = document.createElement('span');
      span.textContent = clip.text || '';
      const bg = s.bg && s.bg !== 'none' ? `background:${s.bg};padding:0.15em 0.5em;border-radius:0.15em;` : '';
      span.style.cssText = `display:inline-block;font-family:${s.fontFamily || 'Inter, -apple-system, sans-serif'};font-weight:${s.weight || 800};font-size:${fontSize}px;color:${s.color || '#ffffff'};${bg}text-shadow:0 2px 14px rgba(0,0,0,0.45);max-width:88%;line-height:1.15;`;
      root.appendChild(span);
    } else if (clip.type === 'caption') {
      const styleName = clip.style?.caption || 'bold';
      const fontSize = Math.round(Math.min(width, height) * (styleName === 'serif' ? 0.045 : 0.05));
      root.className = 'pv-clip pv-textwrap';
      root.style.top = Math.round(height * 0.82) + 'px';
      const span = document.createElement('span');
      span.style.cssText = `display:inline-block;${CAPTION_FONTS[styleName] || CAPTION_FONTS.bold}font-size:${fontSize}px;color:#fff;background:rgba(0,0,0,0.55);padding:0.2em 0.6em;border-radius:0.25em;max-width:86%;line-height:1.25;`;
      if (styleName === 'karaoke' && Array.isArray(clip.words) && clip.words.length) {
        words = clip.words.map((w, i) => {
          const ws = document.createElement('span');
          ws.textContent = w.w;
          if (i > 0) span.appendChild(document.createTextNode(' '));
          span.appendChild(ws);
          return { el: ws, start: w.start };
        });
      } else {
        span.textContent = clip.text || '';
      }
      root.appendChild(span);
    }
    return { root, media, clip, track, words };
  }

  function setEDL(edl, urls) {
    state.edl = edl;
    state.urls = urls || state.urls;
    state.duration = 0;
    for (const track of edl.tracks) {
      for (const clip of track.clips) state.duration = Math.max(state.duration, clip.start + clip.duration);
    }
    if (state.time > state.duration) state.time = Math.max(0, state.duration - 0.001);
    comp.style.background = edl.settings.background;

    // Rebuild, reusing media elements per clipId to avoid reload flicker
    const old = state.els;
    state.els = new Map();
    comp.textContent = '';
    for (const track of edl.tracks) {
      for (const clip of track.clips) {
        const prev = old.get(clip.id);
        let entry;
        const sameMedia = prev && prev.clip.assetId === clip.assetId && prev.clip.type === clip.type;
        if (sameMedia && (clip.type === 'video' || clip.type === 'audio' || clip.type === 'image')) {
          entry = buildClipEl(clip, track);
          if (prev.media && entry.media && prev.media.src === entry.media.src) {
            entry.root.replaceChild(prev.media, entry.media);
            entry.media = prev.media;
            entry.media.style.objectFit = clip.fit;
          }
        } else {
          entry = buildClipEl(clip, track);
        }
        comp.appendChild(entry.root);
        state.els.set(clip.id, entry);
      }
    }
    fitStage();
    render(true);
  }

  function easeOutBack(x) {
    const c = 1.70158 * 2;
    return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
  }

  function applyAnimation(entry, t) {
    const { clip, root } = entry;
    if (clip.type === 'video' || clip.type === 'audio') return;
    const anim = clip.type === 'text' ? (clip.style?.animation ?? 'fade') : (clip.type === 'image' ? 'imgfade' : 'capfade');
    const local = t - clip.start;
    const untilEnd = clip.start + clip.duration - t;
    let opacity = 1, transform = '';

    const inDur = anim === 'capfade' ? 0.12 : 0.5;
    const p = Math.min(1, local / inDur);
    if (anim === 'fade') { opacity = p; transform = `translateY(${(1 - p) * 24}px)`; }
    else if (anim === 'pop') { opacity = Math.min(1, p * 2); transform = `scale(${0.6 + 0.4 * easeOutBack(p)})`; }
    else if (anim === 'slide') { opacity = p; transform = `translateX(${(p - 1) * 80}px)`; }
    else if (anim === 'imgfade') { opacity = p; transform = `scale(${1.04 - 0.04 * p})`; }
    else if (anim === 'capfade') { opacity = p; }

    if (anim !== 'none' && anim !== 'capfade' && clip.duration > 1.2 && untilEnd < 0.4) {
      opacity = Math.max(0, untilEnd / 0.4);
    }
    root.style.opacity = opacity;
    root.style.transform = transform || 'none';

    if (entry.words) {
      const base = entry.words[0].start;
      for (const w of entry.words) {
        w.el.style.color = (local >= (w.start - base)) ? '#facc15' : '#ffffff';
      }
    }
  }

  function render(forceSeek) {
    if (!state.edl) return;
    const t = state.time;
    for (const entry of state.els.values()) {
      const { clip, root, media } = entry;
      const visible = t >= clip.start && t < clip.start + clip.duration;
      root.style.display = visible ? '' : 'none';

      if (media && (clip.type === 'video' || clip.type === 'audio')) {
        const target = clip.in + (t - clip.start) * clip.speed;
        media.volume = clip.muted ? 0 : clip.volume;
        media.playbackRate = clip.speed;
        if (visible && state.playing) {
          if (media.paused) { media.currentTime = target; media.play().catch(() => {}); }
          else if (Math.abs(media.currentTime - target) > 0.18) media.currentTime = target;
        } else {
          if (!media.paused) media.pause();
          if (visible || forceSeek) {
            if (Math.abs(media.currentTime - target) > 0.03) media.currentTime = Math.max(0, target);
          }
        }
      }
      if (visible) applyAnimation(entry, t);
    }
  }

  function tick(now) {
    if (!state.playing) return;
    const dt = (now - state.lastTick) / 1000;
    state.lastTick = now;
    state.time = Math.min(state.duration, state.time + dt);
    if (state.time >= state.duration) {
      state.playing = false;
      pauseAllMedia();
    }
    render(false);
    if (state.playing) requestAnimationFrame(tick);
  }

  function pauseAllMedia() {
    for (const { media } of state.els.values()) {
      if (media && media.pause && !media.paused) media.pause();
    }
  }

  window.PreviewAPI = {
    setEDL,
    play() {
      if (!state.edl || state.duration <= 0) return;
      if (state.time >= state.duration - 0.01) state.time = 0;
      state.playing = true;
      state.lastTick = performance.now();
      requestAnimationFrame(tick);
    },
    pause() {
      state.playing = false;
      pauseAllMedia();
      render(true);
    },
    seek(t) {
      state.time = Math.max(0, Math.min(state.duration, t));
      render(true);
    },
    getTime: () => state.time,
    getDuration: () => state.duration,
    isPlaying: () => state.playing
  };
})();

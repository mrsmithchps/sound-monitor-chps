/**
 * Ruffles & Wispa Classroom Volume Monitor
 * Real-time Web Audio microphone monitor + synthesized classroom alerts
 */

(function () {
  'use strict';

  // --- DOM Elements ---
  const body = document.body;
  const statusHeadline = document.getElementById('statusHeadline');
  const statusSubtext = document.getElementById('statusSubtext');
  const quietTimerEl = document.getElementById('quietTimer');
  const treatCountEl = document.getElementById('treatCount');
  const wakeupCountEl = document.getElementById('wakeupCount');

  const micToggleBtn = document.getElementById('micToggleBtn');
  const micBtnIcon = document.getElementById('micBtnIcon');
  const micBtnLabel = document.getElementById('micBtnLabel');
  const heroStartBtn = document.getElementById('heroStartBtn');
  const heroDemoBtn = document.getElementById('heroDemoBtn');
  const startOverlay = document.getElementById('startOverlay');

  const imgSleeping = document.getElementById('imgSleeping');
  const imgStirring = document.getElementById('imgStirring');
  const imgAwake = document.getElementById('imgAwake');
  const rufflesStatus = document.getElementById('rufflesStatus');
  const wispaStatus = document.getElementById('wispaStatus');

  const levelReadout = document.getElementById('levelReadout');
  const meterTrack = document.getElementById('meterTrack');
  const meterZoneBg = document.getElementById('meterZoneBg');
  const meterFill = document.getElementById('meterFill');
  const wakeProgressBar = document.getElementById('wakeProgressBar');
  const thresholdMarker = document.getElementById('thresholdMarker');
  const thresholdValText = document.getElementById('thresholdValText');
  const presetChips = document.querySelectorAll('.preset-chip');

  const demoBox = document.getElementById('demoBox');
  const demoVolumeSlider = document.getElementById('demoVolumeSlider');
  const toggleDemoMode = document.getElementById('toggleDemoMode');

  const testAlertBtn = document.getElementById('testAlertBtn');
  const resetStatsBtn = document.getElementById('resetStatsBtn');
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const settingsDrawer = document.getElementById('settingsDrawer');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const fullscreenBtn = document.getElementById('fullscreenBtn');

  const sensitivitySlider = document.getElementById('sensitivitySlider');
  const sensitivityLabel = document.getElementById('sensitivityLabel');
  const thresholdSlider = document.getElementById('thresholdSlider');
  const thresholdSliderLabel = document.getElementById('thresholdSliderLabel');
  const holdTimeSelect = document.getElementById('holdTimeSelect');
  const alertSoundSelect = document.getElementById('alertSoundSelect');

  const meetDogsBtn = document.getElementById('meetDogsBtn');
  const photoModal = document.getElementById('photoModal');
  const closeModalBtn = document.getElementById('closeModalBtn');

  // --- App State & Saved Preferences ---
  const STORAGE_KEY = 'ruffles_wispa_monitor_v1';
  const savedPrefs = loadPrefs();

  const state = {
    isRunning: false,
    isDemoMode: false,
    dogState: 'sleeping', // 'sleeping' | 'stirring' | 'awake'

    currentVolume: 0, // 0..100 smoothed
    threshold: savedPrefs.threshold ?? 50,
    sensitivity: savedPrefs.sensitivity ?? 1.0,
    holdDurationMs: savedPrefs.holdDurationMs ?? 1200,
    alertSound: savedPrefs.alertSound ?? 'bark-chime',

    overThresholdMs: 0,
    awakeHoldUntil: 0,
    lastAlertPlayedAt: 0,
    alertPlaybackGuardUntil: 0, // Prevents speaker audio from re-triggering mic

    quietSeconds: 0,
    quietAccumMs: 0,
    treatsEarned: 0,
    wakeupsCount: 0,
  };

  // --- Audio Objects ---
  let audioCtx = null;
  let micStream = null;
  let analyser = null;
  let sampleBuffer = null;
  let rafId = null;
  let lastFrameTime = performance.now();

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          threshold: state.threshold,
          sensitivity: state.sensitivity,
          holdDurationMs: state.holdDurationMs,
          alertSound: state.alertSound,
        })
      );
    } catch (_) {}
  }

  // --- Initialize UI from State ---
  function initUI() {
    updateThresholdUI(state.threshold);
    sensitivitySlider.value = String(state.sensitivity);
    updateSensitivityLabel();
    holdTimeSelect.value = String(state.holdDurationMs);
    alertSoundSelect.value = state.alertSound;
    renderStats();
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  // --- Microphone Control ---
  async function startMicrophone() {
    try {
      ensureAudioContext();

      // Disable browser autoGainControl & noiseSuppression so classroom ambient noise is measured accurately
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        });
      } catch (_) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }

      stopMediaTracks();
      micStream = stream;

      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      sampleBuffer = new Float32Array(analyser.fftSize);

      state.isDemoMode = false;
      state.isRunning = true;
      toggleDemoMode.checked = false;
      demoBox.hidden = true;
      startOverlay.hidden = true;

      micToggleBtn.classList.add('listening');
      micBtnIcon.textContent = '⏸️';
      micBtnLabel.textContent = 'Pause Monitor';

      startLoop();
    } catch (err) {
      console.error('Microphone access error:', err);
      alert(
        'Could not access the microphone (' +
          (err.message || 'Permission denied') +
          '). Switching to Demo Slider mode so you can still try Ruffles & Wispa!'
      );
      startDemoMode();
    }
  }

  function startDemoMode() {
    ensureAudioContext();
    stopMediaTracks();
    state.isDemoMode = true;
    state.isRunning = true;
    toggleDemoMode.checked = true;
    demoBox.hidden = false;
    startOverlay.hidden = true;

    micToggleBtn.classList.add('listening');
    micBtnIcon.textContent = '🎚️';
    micBtnLabel.textContent = 'Stop Demo';

    startLoop();
  }

  function stopMonitor() {
    state.isRunning = false;
    stopMediaTracks();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    micToggleBtn.classList.remove('listening');
    micBtnIcon.textContent = '🎙️';
    micBtnLabel.textContent = 'Start Listening';
    state.currentVolume = 0;
    state.overThresholdMs = 0;
    updateMeterVisuals(0);
    setDogState('sleeping');
  }

  function stopMediaTracks() {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  }

  // --- Main Volume & Classroom State Loop ---
  function startLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    lastFrameTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function readMicPercent(now) {
    if (state.isDemoMode) {
      return Number(demoVolumeSlider.value);
    }
    if (!analyser || !sampleBuffer) return 0;

    // Ignore speaker feedback while our own alert sound is playing
    if (now < state.alertPlaybackGuardUntil) {
      return state.currentVolume * 0.85;
    }

    analyser.getFloatTimeDomainData(sampleBuffer);
    let sumSquares = 0;
    for (let i = 0; i < sampleBuffer.length; i++) {
      const s = sampleBuffer[i];
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / sampleBuffer.length) * state.sensitivity;

    // Convert RMS to decibels: map [-56 dB .. -8 dB] -> [0% .. 100%]
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    const minDb = -56;
    const maxDb = -8;
    const normalized = ((db - minDb) / (maxDb - minDb)) * 100;
    return Math.max(0, Math.min(100, normalized));
  }

  function tick(now) {
    if (!state.isRunning) return;

    const dt = Math.min(100, Math.max(0, now - lastFrameTime));
    lastFrameTime = now;

    const rawLevel = readMicPercent(now);

    // Smooth ballistics: snappy rise, gentle decay
    const alpha = rawLevel > state.currentVolume ? 0.32 : 0.11;
    state.currentVolume = state.currentVolume + (rawLevel - state.currentVolume) * alpha;

    const vol = state.currentVolume;
    const threshold = state.threshold;
    const stirLine = threshold * 0.76;

    // Accumulate or decay sustained loud noise
    if (vol >= threshold) {
      // Extra loud noise fills the wake bar slightly faster
      const excessBoost = 1 + Math.min(1.0, (vol - threshold) / 30);
      state.overThresholdMs = Math.min(
        state.holdDurationMs,
        state.overThresholdMs + dt * excessBoost
      );
    } else {
      state.overThresholdMs = Math.max(0, state.overThresholdMs - dt * 1.35);
    }

    // State Machine Transitions
    if (state.dogState === 'awake') {
      // If still noisy, keep extending awake hold slightly
      if (vol >= threshold * 0.92) {
        state.awakeHoldUntil = Math.max(state.awakeHoldUntil, now + 2600);
        // Re-bark if they stay loud for > 8 seconds straight
        if (now - state.lastAlertPlayedAt > 8500) {
          triggerAlertSound(now);
        }
      } else if (now >= state.awakeHoldUntil && vol < threshold * 0.82) {
        state.overThresholdMs = 0;
        setDogState(vol >= stirLine ? 'stirring' : 'sleeping');
      }
    } else {
      if (state.overThresholdMs >= state.holdDurationMs) {
        wakeUpDogs(now);
      } else if (vol >= stirLine) {
        setDogState('stirring');
      } else if (vol < stirLine - 4) {
        setDogState('sleeping');
      }
    }

    // Track Quiet Time & Dream Treats (1 treat every 120s of quiet/sleeping)
    if (state.dogState === 'sleeping') {
      state.quietAccumMs += dt;
      if (state.quietAccumMs >= 1000) {
        const wholeSecs = Math.floor(state.quietAccumMs / 1000);
        state.quietAccumMs -= wholeSecs * 1000;
        state.quietSeconds += wholeSecs;

        if (state.quietSeconds > 0 && state.quietSeconds % 120 === 0) {
          state.treatsEarned += 1;
          playTreatRewardChime();
        }
        renderStats();
      }
    }

    updateMeterVisuals(vol);
    rafId = requestAnimationFrame(tick);
  }

  function wakeUpDogs(now) {
    state.dogState = 'awake';
    state.awakeHoldUntil = now + 4500;
    state.wakeupsCount += 1;
    state.quietSeconds = 0;
    state.quietAccumMs = 0;
    applyDogVisualState('awake');
    renderStats();
    triggerAlertSound(now);
  }

  function setDogState(nextState) {
    if (state.dogState === nextState) return;
    state.dogState = nextState;
    applyDogVisualState(nextState);
  }

  function applyDogVisualState(s) {
    body.setAttribute('data-state', s);

    imgSleeping.classList.toggle('active', s === 'sleeping');
    imgStirring.classList.toggle('active', s === 'stirring');
    imgAwake.classList.toggle('active', s === 'awake');

    if (s === 'sleeping') {
      statusHeadline.textContent = 'Shhh… Ruffles & Wispa are fast asleep!';
      statusSubtext.textContent = 'Keep our classroom voices calm so the puppies can dream.';
      rufflesStatus.textContent = '💤 Dreaming';
      wispaStatus.textContent = '💤 Snoozing';
    } else if (s === 'stirring') {
      statusHeadline.textContent = 'Careful… Ruffles & Wispa are starting to stir!';
      statusSubtext.textContent = 'Voices are getting louder — let’s bring the volume gently down.';
      rufflesStatus.textContent = '👂 Ears Perked';
      wispaStatus.textContent = '👀 Peeking';
    } else if (s === 'awake') {
      statusHeadline.textContent = 'Uh oh! Too Noisy — Ruffles & Wispa Woke Up!';
      statusSubtext.textContent = 'Let’s quiet our voices right down so the puppies can go back to sleep.';
      rufflesStatus.textContent = '🐶 WOOF! Awake!';
      wispaStatus.textContent = '🐶 ARF! Awake!';
    }
  }

  function updateMeterVisuals(vol) {
    const rounded = Math.round(vol);
    levelReadout.textContent = rounded + '%';
    meterFill.style.height = Math.min(100, Math.max(2, vol)).toFixed(1) + '%';

    const progressPct = Math.min(100, (state.overThresholdMs / state.holdDurationMs) * 100);
    wakeProgressBar.style.height = progressPct.toFixed(1) + '%';
  }

  function updateThresholdUI(val) {
    const clamped = Math.max(15, Math.min(95, Math.round(val)));
    state.threshold = clamped;
    thresholdMarker.style.bottom = clamped + '%';
    thresholdMarker.setAttribute('aria-valuenow', String(clamped));
    thresholdValText.textContent = String(clamped);
    thresholdSlider.value = String(clamped);
    thresholdSliderLabel.textContent = clamped + '%';

    // Update colored background zones inside thermometer
    const stir = Math.round(clamped * 0.76);
    meterZoneBg.style.background = `linear-gradient(to top,
      #22c55e 0%,
      #22c55e ${stir}%,
      #f59e0b ${stir}%,
      #f59e0b ${clamped}%,
      #ef4444 ${clamped}%,
      #ef4444 100%)`;

    // Highlight matching preset chip if any
    presetChips.forEach((chip) => {
      chip.classList.toggle('active', Number(chip.dataset.threshold) === clamped);
    });

    savePrefs();
  }

  function renderStats() {
    const mins = String(Math.floor(state.quietSeconds / 60)).padStart(2, '0');
    const secs = String(state.quietSeconds % 60).padStart(2, '0');
    quietTimerEl.textContent = `${mins}:${secs}`;
    treatCountEl.textContent = String(state.treatsEarned);
    wakeupCountEl.textContent = String(state.wakeupsCount);
  }

  // --- Synthesized Classroom Audio Alerts ---
  function triggerAlertSound(now) {
    state.lastAlertPlayedAt = now;
    const mode = state.alertSound;
    if (mode === 'silent') return;

    ensureAudioContext();
    state.alertPlaybackGuardUntil = now + 2200;

    if (mode === 'bark-chime') {
      playClassroomChime(0);
      playPuppyBark(0.35, 1.0); // Ruffles bark
      playPuppyBark(0.68, 1.24); // Wispa higher-pitched puppy yip!
    } else if (mode === 'voice-bark') {
      playPuppyBark(0, 1.05);
      playPuppyBark(0.28, 1.28);
      state.alertPlaybackGuardUntil = now + 4200;
      setTimeout(() => speakAlertPhrase(), 520);
    } else if (mode === 'bell') {
      playClassroomChime(0);
    } else if (mode === 'shush') {
      playShushSound(0);
      playClassroomChime(0.85);
    }
  }

  // Friendly synthesized puppy bark ("Woof! Arf!")
  function playPuppyBark(delaySec = 0, pitchMult = 1.0) {
    const ctx = ensureAudioContext();
    const t0 = ctx.currentTime + delaySec;

    // Vocal cord pitch contour (quick rise then drop)
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const formant = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc2.type = 'triangle';

    osc.frequency.setValueAtTime(195 * pitchMult, t0);
    osc.frequency.exponentialRampToValueAtTime(390 * pitchMult, t0 + 0.045);
    osc.frequency.exponentialRampToValueAtTime(150 * pitchMult, t0 + 0.19);

    osc2.frequency.setValueAtTime(390 * pitchMult, t0);
    osc2.frequency.exponentialRampToValueAtTime(740 * pitchMult, t0 + 0.045);
    osc2.frequency.exponentialRampToValueAtTime(290 * pitchMult, t0 + 0.19);

    formant.type = 'bandpass';
    formant.frequency.setValueAtTime(680 * pitchMult, t0);
    formant.frequency.exponentialRampToValueAtTime(1150 * pitchMult, t0 + 0.06);
    formant.frequency.exponentialRampToValueAtTime(520 * pitchMult, t0 + 0.19);
    formant.Q.value = 2.6;

    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(0.42, t0 + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.21);

    // Add brief breathy "ruff" burst
    const noiseLen = Math.floor(ctx.sampleRate * 0.16);
    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.05));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.22;

    osc.connect(formant);
    osc2.connect(formant);
    noise.connect( noiseGain );
    noiseGain.connect(formant);
    formant.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t0);
    osc2.start(t0);
    noise.start(t0);
    osc.stop(t0 + 0.22);
    osc2.stop(t0 + 0.22);
  }

  // Warm two-note teacher attention desk chime
  function playClassroomChime(delaySec = 0) {
    const ctx = ensureAudioContext();
    const notes = [659.25, 880.0]; // E5 -> A5

    notes.forEach((freq, idx) => {
      const t = ctx.currentTime + delaySec + idx * 0.18;
      const osc = ctx.createOscillator();
      const harmonic = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);

      harmonic.type = 'sine';
      harmonic.frequency.setValueAtTime(freq * 2, t);

      const hGain = ctx.createGain();
      hGain.gain.value = 0.15;

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.32, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.95);

      osc.connect(gain);
      harmonic.connect(hGain);
      hGain.connect(gain);
      gain.connect(ctx.destination);

      osc.start(t);
      harmonic.start(t);
      osc.stop(t + 1.0);
      harmonic.stop(t + 1.0);
    });
  }

  // Gentle breathy "Shhhhh..." sound
  function playShushSound(delaySec = 0) {
    const ctx = ensureAudioContext();
    const t0 = ctx.currentTime + delaySec;
    const dur = 0.78;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
      ch[i] = Math.random() * 2 - 1;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2900, t0);
    filter.Q.value = 1.6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(0.18, t0 + 0.14);
    gain.gain.setValueAtTime(0.16, t0 + 0.45);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(t0);
  }

  function speakAlertPhrase() {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const msg = new SpeechSynthesisUtterance(
        'Uh oh! Too noisy! You woke up Ruffles and Wispa. Let us use quiet voices.'
      );
      msg.rate = 0.98;
      msg.pitch = 1.08;
      window.speechSynthesis.speak(msg);
    } catch (_) {}
  }

  function playTreatRewardChime() {
    if (state.alertSound === 'silent') return;
    const ctx = ensureAudioContext();
    state.alertPlaybackGuardUntil = performance.now() + 900;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.09;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.4);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.42);
    });
  }

  // --- Event Listeners ---
  heroStartBtn.addEventListener('click', () => startMicrophone());
  heroDemoBtn.addEventListener('click', () => startDemoMode());

  micToggleBtn.addEventListener('click', () => {
    if (state.isRunning) {
      stopMonitor();
    } else if (toggleDemoMode.checked) {
      startDemoMode();
    } else {
      startMicrophone();
    }
  });

  // Preset Chips
  presetChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      updateThresholdUI(Number(chip.dataset.threshold));
    });
  });

  // Dragging / Clicking Threshold on Thermometer Track
  let isDraggingThreshold = false;

  function setThresholdFromPointer(clientY) {
    const rect = meterTrack.getBoundingClientRect();
    const pct = ((rect.bottom - clientY) / rect.height) * 100;
    updateThresholdUI(pct);
  }

  meterTrack.addEventListener('pointerdown', (e) => {
    isDraggingThreshold = true;
    meterTrack.setPointerCapture(e.pointerId);
    setThresholdFromPointer(e.clientY);
  });

  meterTrack.addEventListener('pointermove', (e) => {
    if (!isDraggingThreshold) return;
    setThresholdFromPointer(e.clientY);
  });

  meterTrack.addEventListener('pointerup', () => {
    isDraggingThreshold = false;
  });

  thresholdMarker.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      updateThresholdUI(state.threshold + 2);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      updateThresholdUI(state.threshold - 2);
    }
  });

  // Settings Controls
  function updateSensitivityLabel() {
    const v = state.sensitivity;
    const desc = v < 0.8 ? 'Low' : v > 1.3 ? 'High' : 'Normal';
    sensitivityLabel.textContent = `${v.toFixed(1)}× (${desc})`;
  }

  sensitivitySlider.addEventListener('input', () => {
    state.sensitivity = Number(sensitivitySlider.value);
    updateSensitivityLabel();
    savePrefs();
  });

  thresholdSlider.addEventListener('input', () => {
    updateThresholdUI(Number(thresholdSlider.value));
  });

  holdTimeSelect.addEventListener('change', () => {
    state.holdDurationMs = Number(holdTimeSelect.value);
    savePrefs();
  });

  alertSoundSelect.addEventListener('change', () => {
    state.alertSound = alertSoundSelect.value;
    savePrefs();
    // Play a quick preview when changing sound
    triggerAlertSound(performance.now());
  });

  toggleDemoMode.addEventListener('change', () => {
    if (toggleDemoMode.checked) {
      startDemoMode();
    } else {
      demoBox.hidden = true;
      if (state.isRunning) {
        startMicrophone();
      }
    }
  });

  // Test Wake-Up Button (lets teacher show the class what happens!)
  testAlertBtn.addEventListener('click', () => {
    startOverlay.hidden = true;
    const now = performance.now();
    state.dogState = 'awake';
    state.awakeHoldUntil = now + 4200;
    applyDogVisualState('awake');
    triggerAlertSound(now);

    if (!state.isRunning) {
      meterFill.style.height = Math.min(96, state.threshold + 22) + '%';
      levelReadout.textContent = Math.min(96, state.threshold + 22) + '%';
      setTimeout(() => {
        if (!state.isRunning) {
          setDogState('sleeping');
          meterFill.style.height = '0%';
          levelReadout.textContent = '0%';
        }
      }, 4200);
    }
  });

  resetStatsBtn.addEventListener('click', () => {
    state.quietSeconds = 0;
    state.quietAccumMs = 0;
    state.treatsEarned = 0;
    state.wakeupsCount = 0;
    renderStats();
  });

  // Settings Drawer Toggle
  settingsToggleBtn.addEventListener('click', () => {
    const isHidden = settingsDrawer.hidden;
    settingsDrawer.hidden = !isHidden;
    settingsToggleBtn.setAttribute('aria-expanded', String(isHidden));
    if (isHidden) {
      settingsDrawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsDrawer.hidden = true;
    settingsToggleBtn.setAttribute('aria-expanded', 'false');
  });

  // Fullscreen Whiteboard Button
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  });

  // Real Photos Modal ("Meet Ruffles & Wispa")
  meetDogsBtn.addEventListener('click', () => {
    photoModal.hidden = false;
  });

  closeModalBtn.addEventListener('click', () => {
    photoModal.hidden = true;
  });

  photoModal.addEventListener('click', (e) => {
    if (e.target === photoModal) {
      photoModal.hidden = true;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !photoModal.hidden) {
      photoModal.hidden = true;
    }
  });

  initUI();
})();

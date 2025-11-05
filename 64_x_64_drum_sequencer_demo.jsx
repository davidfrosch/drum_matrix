import React, { useEffect, useRef, useState, useCallback } from 'react';

// Fully self-contained React single-file demo for a 64x64 grid drum sequencer.
// - 64x64 clickable grid (black = on, white = off)
// - Selection is always 4 rows tall; user can drag horizontally to set length; click -> 4x4
// - Selection highlighted with blue border
// - Selection becomes a 4-voice step sequencer (columns = steps, rows = voices)
// - Mode switch: Sample or MIDI. In Sample mode you can drop audio files into 4 sample slots.
// - Play/Stop, BPM input, Randomize (scheduled on next beat), and real-time updates
// - Uses a built-in SequencerEngine (samples + WebMIDI fallback) that respects per-row volume & mute

// NOTE: This demo is intended to run inside the canvas preview. To use it in a real app,
// extract the component and bundle it with a React app.

// -------------------- Sequencer Engine (same logic as earlier) --------------------
class SequencerEngine {
  constructor(opts = {}) {
    this.mode = opts.mode || 'sample';
    this.numRows = opts.numRows || 4;
    this.audioCtx = opts.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    this.defaultNoteLength = opts.defaultNoteLength || 0.3;
    this.scheduleAheadTime = opts.scheduleAheadTime || 0.1;
    this.breakbeatBPM = opts.breakbeatBPM || 175; // Store original BPM of breakbeat
    this.currentBPM = opts.currentBPM || 175; // Store current sequencer BPM
    this.noteLength = opts.noteLength || '1/8'; // Store note length division (default 1/8)
    this.breakbeatOneShot = true; // One-shot mode by default
    this.breakbeatPitch = 0; // No pitch shift by default

    this.sampleBuffers = new Array(this.numRows).fill(null);
    this.muted = new Array(this.numRows).fill(false);
    this.volumes = new Array(this.numRows).fill(1.0);
    this.midiNotes = [36, 38, 42, 46].slice(0, this.numRows);
    
    // Expand midiNotes array if numRows > 4
    while (this.midiNotes.length < this.numRows) {
      this.midiNotes.push(60 + this.midiNotes.length); // Add more notes
    }

    this.midiAccess = null;
    this.midiOutput = null;
    this.midiChannel = 1;

    this._scheduledTimeouts = new Set();
    this._scheduledSources = new Set();
    this._scheduledGains = new Map(); // Map source -> gain for fadeouts
    this._breakbeatSources = new Set(); // Track breakbeat sources separately for mutual exclusivity

    // Callbacks for slice visual feedback
    this.onSliceTriggered = null;
    this.onSliceEnded = null;

    // Callbacks for row visual feedback (sample and MIDI modes)
    this.onRowTriggered = null;

    if (navigator.requestMIDIAccess) {
      navigator.requestMIDIAccess({ sysex: false })
        .then(m => { this.midiAccess = m; })
        .catch(() => { this.midiAccess = null; });
    }

    this._userGestureBound = this._bindResumeOnGesture.bind(this);
  window.addEventListener('pointerdown', this._userGestureBound, { once: true, passive: true });
  window.addEventListener('keydown', this._userGestureBound, { once: true, passive: true });
  }

  setMode(m) { this.mode = m; }
  setMidiOutput(output) { this.midiOutput = output; }
  setMidiChannel(ch) { this.midiChannel = Math.max(1, Math.min(16, ch | 0)); }
  loadSample(rowIndex, audioBuffer) { if (rowIndex>=0 && rowIndex<this.numRows) this.sampleBuffers[rowIndex]=audioBuffer; }
  setVolume(rowIndex, v) { if (rowIndex>=0 && rowIndex<this.numRows) this.volumes[rowIndex]=Math.max(0,Math.min(1,v)); }
  setMute(rowIndex, m) { if (rowIndex>=0 && rowIndex<this.numRows) this.muted[rowIndex]=!!m; }
  setMidiNoteForRow(rowIndex,n){ if (rowIndex>=0&&rowIndex<this.numRows) this.midiNotes[rowIndex]=n|0; }
  setBreakbeatBPM(bpm) { this.breakbeatBPM = bpm; } // Update BPM for recalculation
  setCurrentBPM(bpm) { this.currentBPM = bpm; } // Update current sequencer BPM
  setNoteLength(noteLength) { this.noteLength = noteLength; } // Update note length for slice calculation
  setBreakbeatOneShot(oneShot) { this.breakbeatOneShot = oneShot; } // One-shot mode toggle
  setBreakbeatPitch(pitch) { this.breakbeatPitch = pitch; } // Pitch adjustment in semitones
  
  setBreakbeatBuffer(buffer) { this.breakbeatBuffer = buffer; }
  
  playBreakbeatSlice(sliceIndex, totalSlices, when=null, velocity=127) {
    console.log('playBreakbeatSlice called:', { sliceIndex, totalSlices, hasBuffer: !!this.breakbeatBuffer, muted: this.muted[sliceIndex], volume: this.volumes[sliceIndex] });
    
    if (!this.breakbeatBuffer) {
      console.error('No breakbeat buffer!');
      return;
    }
    if (this.muted[sliceIndex]) {
      console.log('Slice is muted:', sliceIndex);
      return;
    }
    
    const buffer = this.breakbeatBuffer;
    console.log('Buffer duration:', buffer.duration, 'BPM ratio:', this.currentBPM, '/', this.breakbeatBPM);
    
    // Calculate playback rate to time-stretch the breakbeat to match current BPM
    // breakbeatBPM is the original tempo, currentBPM is the target tempo
    const tempoPlaybackRate = this.currentBPM / this.breakbeatBPM;
    
    // Apply pitch shift (in semitones)
    // pitchShift in semitones: rate = 2^(semitones/12)
    const pitchPlaybackRate = Math.pow(2, this.breakbeatPitch / 12);
    
    // Combine tempo and pitch adjustments
    const playbackRate = tempoPlaybackRate * pitchPlaybackRate;
    
    // Calculate how long each slice should be at the current BPM and note length
    // The whole breakbeat is assumed to be one bar (4 beats) at breakbeatBPM
    // Each slice represents a portion of that bar based on note length
    const noteDivisors = {
      '1/4': 1,    // quarter notes - 8 slices = 2 bars
      '1/8': 2,    // eighth notes - 8 slices = 1 bar
      '1/16': 4,   // sixteenth notes - 8 slices = 1/2 bar
      '1/32': 8    // thirty-second notes - 8 slices = 1/4 bar
    };
    const divisor = noteDivisors[this.noteLength] || 4;
    
    // Capture one-shot mode at scheduling time (not at playback time)
    const isOneShot = this.breakbeatOneShot;
    
    // Duration of one note at current BPM
    const oneNoteDuration = 60 / this.currentBPM / divisor;
    
    // Start offset in the original audio buffer
    const startOffset = sliceIndex * (buffer.duration / totalSlices);
    const sliceBufferDuration = buffer.duration / totalSlices;
    
    const playTime = (typeof when==='number')? when : this.audioCtx.currentTime;
    const now = this.audioCtx.currentTime;
    
    // Trigger visual feedback immediately when scheduled (not when it starts playing)
    if (this.onSliceTriggered) {
      this.onSliceTriggered(sliceIndex);
    }
    
    this._resumeAudioContextIfNeeded().then(()=>{
      // Always stop currently playing slices for mutual exclusivity, but schedule the fade/stop
      // to occur at the new slice's playTime (or now if playTime is in the past). This prevents
      // cutting existing slices prematurely when scheduling ahead.
      const fadeOutTime = 0.002; // 2ms quick fadeout
      try {
        const stopAtBase = Math.max(now, playTime);
        const stopAt = stopAtBase + fadeOutTime;
        for (const s of this._breakbeatSources) {
          const gain = this._scheduledGains.get(s);
          if (gain && gain.gain) {
            try {
              const currentGain = gain.gain.value;
              gain.gain.cancelScheduledValues(stopAtBase);
              // Keep current level until stopAtBase, then fade out
              gain.gain.setValueAtTime(currentGain, stopAtBase);
              gain.gain.linearRampToValueAtTime(0.0001, stopAt);
            } catch (e) {}
          }
          try {
            if (typeof s.stop === 'function') {
              s.stop(stopAt);
            }
          } catch (e) {}
        }
        this._breakbeatSources.clear();
      } catch (e) {}
      
      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      // Set playback rate to time-stretch and pitch shift
      // Set at currentTime and playTime to ensure value is applied even for future-scheduled starts
      try {
        source.playbackRate.setValueAtTime(playbackRate, this.audioCtx.currentTime);
        source.playbackRate.setValueAtTime(playbackRate, playTime);
      } catch (e) {
        console.error('Error setting playbackRate:', playbackRate, e);
      }
      
      const gain = this.audioCtx.createGain();
      const velocityFactor = (velocity / 127) || 1.0;
      let targetGain = this.volumes[sliceIndex] * velocityFactor;
      if (!isFinite(targetGain) || targetGain <= 0) {
        console.warn('Invalid targetGain for slice', sliceIndex, 'computed:', targetGain, 'falling back to 1.0');
        targetGain = 1.0;
      }
      // Apply gain at currentTime and playTime to be safe
      gain.gain.setValueAtTime(targetGain, this.audioCtx.currentTime);
      gain.gain.setValueAtTime(targetGain, playTime);
      
      source.connect(gain);
      gain.connect(this.audioCtx.destination);
      
      try { 
        this._scheduledSources.add(source);
        this._scheduledGains.set(source, gain);
        this._breakbeatSources.add(source);
      } catch (e) {}
      
      if (isOneShot) {
        // One-shot mode: play only the slice duration, then fade and stop
        const fadeDuration = Math.min(0.01, oneNoteDuration * 0.1);
        const fadeStart = playTime + oneNoteDuration - fadeDuration;
        
        // Schedule fade out at the end
        gain.gain.setValueAtTime(targetGain, fadeStart);
        gain.gain.linearRampToValueAtTime(0.0001, fadeStart + fadeDuration);
        
        // Play the slice - use stop() to control duration, NOT the duration parameter!
        try {
          console.log('Starting one-shot playback:', { playTime, now: this.audioCtx.currentTime, startOffset, oneNoteDuration, playbackRate, targetGain });
          console.log('Source connected?', !!source.numberOfOutputs, 'Gain connected?', !!gain.numberOfOutputs);
          console.log('Gain current value (immediate):', gain.gain.value);
          source.start(playTime, startOffset);
          // Stop a tiny bit after the fade to ensure the fade has time to finish
          const stopMargin = 0.02; // 20ms tail
          source.stop(playTime + oneNoteDuration + stopMargin);
        } catch (e) {
          console.error('Error starting one-shot source:', e);
        }
      } else {
        // Continuous mode: play the whole slice, let it run until stopped by next trigger
        try {
          console.log('Starting continuous playback:', { playTime, now: this.audioCtx.currentTime, startOffset, playbackRate, targetGain });
          source.start(playTime, startOffset);
        } catch (e) {
          console.error('Error starting continuous source:', e);
        }
        // No fade out, no stop scheduled - will be stopped by next slice trigger
      }
      
      source.onended = () => {
        console.log('breakbeat source ended:', { sliceIndex, now: this.audioCtx.currentTime });
        try { source.disconnect(); } catch (e) {}
        try { gain.disconnect(); } catch (e) {}
        try { 
          this._scheduledSources.delete(source);
          this._scheduledGains.delete(source);
          this._breakbeatSources.delete(source);
        } catch (e) {}
        if (this.onSliceEnded && this._breakbeatSources.size === 0) {
          this.onSliceEnded();
        }
      };
    }).catch((err)=>{ 
      console.error('Error in playBreakbeatSlice promise:', err);
    });
  }

  async _resumeAudioContextIfNeeded(){
    try {
      console.log('_resumeAudioContextIfNeeded: state=', this.audioCtx.state);
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
        console.log('_resumeAudioContextIfNeeded: resumed, state=', this.audioCtx.state);
      }
    } catch (err) {
      console.error('_resumeAudioContextIfNeeded error:', err);
      throw err;
    }
  }

  _bindResumeOnGesture(){
    try {
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        console.log('_bindResumeOnGesture: attempting resume due to user gesture');
        this.audioCtx.resume().then(()=>{
          console.log('_bindResumeOnGesture: resumed');
          try {
            // Quick oscillator beep to confirm audio output chain
            const t = this.audioCtx.currentTime;
            const osc = this.audioCtx.createOscillator();
            const g = this.audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, t);
            g.gain.setValueAtTime(0.001, t); // very quiet
            osc.connect(g); g.connect(this.audioCtx.destination);
            osc.start(t);
            osc.stop(t + 0.02);
          } catch (e) {
            console.error('osc test failed:', e);
          }
        }).catch((e)=>console.error('_bindResumeOnGesture resume error:', e));
      }
      if (navigator.requestMIDIAccess && !this.midiAccess) navigator.requestMIDIAccess({ sysex:false }).then(m=>this.midiAccess=m).catch(()=>{});
    } catch (e) {
      console.error('_bindResumeOnGesture error:', e);
    }
  }

  triggerRow(rowIndex, when=null, velocity=127){ 
    if (rowIndex<0||rowIndex>=this.numRows) return; 
    if (this.muted[rowIndex]) return; 
    const playTime = (typeof when==='number')? when : this.audioCtx.currentTime; 
    
    // Trigger visual feedback callback
    if (this.onRowTriggered) {
      this.onRowTriggered(rowIndex);
    }
    
    this._resumeAudioContextIfNeeded().then(()=>{ 
      if (this.mode==='sample') this._playSample(rowIndex, playTime, velocity); 
      else this._playMidiNote(rowIndex, playTime, velocity); 
    }).catch(()=>{}); 
  }

  // Cancel timeouts and any scheduled AudioNodes (buffer sources / oscillators)
  // Apply quick fadeout to prevent clicks
  cancelScheduled() {
    for (const id of this._scheduledTimeouts) clearTimeout(id);
    this._scheduledTimeouts.clear();
    const now = this.audioCtx.currentTime;
    const fadeOutTime = 0.005; // 5ms fadeout to prevent clicks
    try {
      for (const s of this._scheduledSources) {
        try {
          // If we have a tracked gain node, fade it out
          const gain = this._scheduledGains.get(s);
          if (gain && gain.gain) {
            const currentGain = gain.gain.value;
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(currentGain, now);
            gain.gain.linearRampToValueAtTime(0.0001, now + fadeOutTime);
          }
          // Stop the source after fadeout
          if (typeof s.stop === 'function') {
            s.stop(now + fadeOutTime);
          }
        } catch (e) {
          // If already stopped or in invalid state, try disconnect
          try { if (s.disconnect) s.disconnect(); } catch (e2) {}
        }
      }
    } catch (e) {}
    this._scheduledSources.clear();
    this._scheduledGains.clear();
    this._breakbeatSources.clear();
  }

  _playSample(rowIndex, time, velocity) {
    const buffer = this.sampleBuffers[rowIndex];
    if (!buffer) {
      this._playOscillatorFallback(rowIndex, time, velocity);
      return;
    }
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    const gain = this.audioCtx.createGain();
    const velocityFactor = (velocity / 127) || 1.0;
    const targetGain = this.volumes[rowIndex] * velocityFactor;
    gain.gain.setValueAtTime(targetGain, time);

    const fadeStart = time + Math.max(0.001, this.defaultNoteLength * 0.6);
    const fadeDuration = Math.max(0.01, this.defaultNoteLength * 0.4);
    gain.gain.setValueAtTime(targetGain, fadeStart);
    gain.gain.linearRampToValueAtTime(0.0001, fadeStart + fadeDuration);

    source.connect(gain);
    gain.connect(this.audioCtx.destination);
    try { 
      this._scheduledSources.add(source);
      this._scheduledGains.set(source, gain);
    } catch (e) {}
    source.start(time);
    const stopTime = Math.min(time + buffer.duration, fadeStart + fadeDuration + 0.05);
    source.stop(stopTime);
    source.onended = () => {
      try { source.disconnect(); } catch (e) {}
      try { gain.disconnect(); } catch (e) {}
      try { 
        this._scheduledSources.delete(source);
        this._scheduledGains.delete(source);
      } catch (e) {}
    };
  }

  _playMidiNote(rowIndex, time, velocity){ const noteNumber = this.midiNotes[rowIndex]|0; const vel = Math.max(0,Math.min(127,velocity|0)); const chan = ((this.midiChannel-1)&0xF); const statusOn = 0x90|chan; const statusOff = 0x80|chan; const noteOnMsg=[statusOn,noteNumber,vel]; const noteOffMsg=[statusOff,noteNumber,0]; const nowAudio = this.audioCtx.currentTime; const nowPerf = performance.now()/1000; const perfToAudioOffset = nowPerf - nowAudio; const noteOnPerfMs = (time + perfToAudioOffset)*1000; const noteOffPerfMs = (time + this.defaultNoteLength + perfToAudioOffset)*1000;
    if (this.midiOutput && typeof this.midiOutput.send==='function'){
      try{ this.midiOutput.send(noteOnMsg, Math.round(noteOnPerfMs)); this.midiOutput.send(noteOffMsg, Math.round(noteOffPerfMs)); }
      catch(e){ this.midiOutput.send(noteOnMsg); const msDelay=Math.max(0,(this.defaultNoteLength)*1000); const id=setTimeout(()=>{ try{ this.midiOutput.send(noteOffMsg) }catch(e){} this._scheduledTimeouts.delete(id); }, msDelay); this._scheduledTimeouts.add(id); }
    } else {
      // Only use oscillator fallback if no MIDI output is available
      this._playOscillatorFallback(rowIndex, time, velocity);
    }
  }

  _playOscillatorFallback(rowIndex, time, velocity) {
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    const midiNote = (this.midiNotes[rowIndex] || 60);
    const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
    osc.frequency.setValueAtTime(freq, time);
    osc.type = 'sine';
    const velocityFactor = (velocity / 127) || 1.0;
    const initGain = Math.max(0, Math.min(1, this.volumes[rowIndex] * velocityFactor * 0.15));
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(initGain, time + 0.005);
    const releaseStart = time + Math.max(0.01, this.defaultNoteLength * 0.6);
    gain.gain.setValueAtTime(initGain, releaseStart);
    gain.gain.linearRampToValueAtTime(0.0001, releaseStart + Math.max(0.02, this.defaultNoteLength * 0.4));
    osc.connect(gain);
    gain.connect(this.audioCtx.destination);
    try { 
      this._scheduledSources.add(osc);
      this._scheduledGains.set(osc, gain);
    } catch (e) {}
    osc.start(time);
    const stopAt = releaseStart + Math.max(0.02, this.defaultNoteLength * 0.4) + 0.05;
    osc.stop(stopAt);
    osc.onended = () => {
      try { osc.disconnect(); } catch (e) {}
      try { gain.disconnect(); } catch (e) {}
      try { 
        this._scheduledSources.delete(osc);
        this._scheduledGains.delete(osc);
      } catch (e) {}
    };
  }
}

// -------------------- React UI --------------------
export default function SequencerDemo() {
  const ROWS = 64, COLS = 64;
  const [grid, setGrid] = useState(() => new Uint8Array(ROWS * COLS).fill(0));
  const [selection, setSelection] = useState({ active: true, startRow: 30, startCol: 28, length: 8 }); // Default selection in middle
  const [isDragging, setIsDragging] = useState(false);
  const [engine] = useState(() => new SequencerEngine({ mode: 'sample', numRows: 32 })); // Support up to 32 rows for 1/32 notes
  const audioCtxRef = useRef(engine.audioCtx);
  const [controlsCollapsed, setControlsCollapsed] = useState(false); // State for collapsible controls

  // realtime refs so scheduler uses up-to-date values (selection/grid/mute/volumes)
  const selectionRef = useRef(selection);
  const gridStateRef = useRef(grid);

  const [mode, setMode] = useState('sample');
  const [bpm, setBpm] = useState(175);
  const [playing, setPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [noteLength, setNoteLength] = useState('1/8'); // Note division: 1/4, 1/8, 1/16, 1/32
  const [stepIntervalSec, setStepIntervalSec] = useState(() => 60 / 175 / 2); // 8th notes at 175 BPM
  const [currentlyPlayingSlice, setCurrentlyPlayingSlice] = useState(-1); // Track which slice is currently playing
  const [sliceFlashKey, setSliceFlashKey] = useState(0); // Key to trigger re-render for flash animation
  const [currentlyPlayingRow, setCurrentlyPlayingRow] = useState(-1); // Track which row is currently playing (sample/MIDI modes)
  const [rowFlashKey, setRowFlashKey] = useState(0); // Key to trigger re-render for row flash animation
  const [pulseAnimation, setPulseAnimation] = useState(0); // For BPM-synchronized pulse animation
  const [samplesInfo, setSamplesInfo] = useState(new Array(4).fill(null));
  const [mute, setMute] = useState([false,false,false,false]);
  const [volumes, setVolumes] = useState([1,1,1,1]);
  const [midiNotes, setMidiNotes] = useState([36, 38, 42, 46]); // Kick, Snare, HiHat, Tom
  
  // Breakbeat slicer mode state
  const [breakbeatBuffer, setBreakbeatBuffer] = useState(null);
  const [breakbeatBPM, setBreakbeatBPM] = useState(175);
  const [breakbeatWaveform, setBreakbeatWaveform] = useState(null);
  const [sliceMute, setSliceMute] = useState(new Array(8).fill(false));
  const [sliceVolumes, setSliceVolumes] = useState(new Array(8).fill(1));
  const [numSlices, setNumSlices] = useState(8); // Number of slices based on note length
  const [density, setDensity] = useState(0.4); // Grid fill density (0 = empty, 1 = full)
  const [densityDisplay, setDensityDisplay] = useState(0.4); // Immediate display value for slider
  const [breakbeatOneShot, setBreakbeatOneShot] = useState(true); // One-shot mode (true) vs continuous (false)
  const [breakbeatPitch, setBreakbeatPitch] = useState(0); // Pitch adjustment in semitones (-12 to +12)
  
  const numRows = mode === 'breakbeat' ? numSlices : 4;

  const muteRef = useRef(mute);
  const volumesRef = useRef(volumes);
  const sliceMuteRef = useRef(sliceMute);
  const sliceVolumesRef = useRef(sliceVolumes);
  const modeRef = useRef(mode);
  const numSlicesRef = useRef(numSlices);

  // scheduling refs
  const nextStepTimeRef = useRef(0);
  const currentColRef = useRef(0);
  const lookaheadTimerRef = useRef(null);
  const pendingSelectionRef = useRef(null); // For beat-quantized selection changes
  const absoluteTimeRef = useRef(0); // Absolute audio time when sequencer started
  const sequenceStartTimeRef = useRef(0); // When current sequence started in absolute time

  useEffect(()=>{ engine.setMode(mode); }, [mode, engine]);

  // Set up slice visual feedback callbacks
  useEffect(() => {
    engine.onSliceTriggered = (sliceIndex) => {
      setCurrentlyPlayingSlice(sliceIndex);
      setSliceFlashKey(prev => prev + 1); // Increment key to trigger new flash animation
      
      // Clear the playing state after a short duration (visual flash)
      setTimeout(() => {
        setCurrentlyPlayingSlice(-1);
      }, 100); // 100ms flash duration
    };
    engine.onSliceEnded = () => {
      // Don't clear here - let the timeout handle it
    };
    
    // Set up row visual feedback callbacks for sample and MIDI modes
    engine.onRowTriggered = (rowIndex) => {
      setCurrentlyPlayingRow(rowIndex);
      setRowFlashKey(prev => prev + 1); // Increment key to trigger new flash animation
      
      // Clear the playing state after a short duration (visual flash)
      setTimeout(() => {
        setCurrentlyPlayingRow(-1);
      }, 100); // 100ms flash duration
    };
    
    return () => {
      engine.onSliceTriggered = null;
      engine.onSliceEnded = null;
      engine.onRowTriggered = null;
    };
  }, [engine]);

  // BPM-synchronized pulse animation for play button
  useEffect(() => {
    if (!playing) {
      setPulseAnimation(0);
      return;
    }

    const beatDuration = (60 / bpm) * 1000; // Duration of one beat in milliseconds
    let animationId;
    let startTime = Date.now();

    const updatePulse = () => {
      const elapsed = Date.now() - startTime;
      const progress = (elapsed % beatDuration) / beatDuration;
      // Create a pulse that peaks at the beat and fades out
      const pulseValue = Math.sin(progress * Math.PI * 2) * 0.5 + 0.5;
      setPulseAnimation(pulseValue);
      animationId = requestAnimationFrame(updatePulse);
    };

    updatePulse();

    return () => {
      if (animationId) cancelAnimationFrame(animationId);
    };
  }, [playing, bpm]);
  
  // Helper to generate waveform from buffer
  const generateWaveform = useCallback((audioBuffer) => {
    const channelData = audioBuffer.getChannelData(0);
    const samples = 200; // Number of waveform points
    const blockSize = Math.floor(channelData.length / samples);
    const waveformData = [];
    
    for (let i = 0; i < samples; i++) {
      const start = blockSize * i;
      let min = 1;
      let max = -1;
      for (let j = 0; j < blockSize; j++) {
        const sample = channelData[start + j];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
      waveformData.push({ min, max });
    }
    
    return waveformData;
  }, []);
  
  // Update engine breakbeat BPM when it changes
  useEffect(() => {
    engine.setBreakbeatBPM(breakbeatBPM);
  }, [breakbeatBPM, engine]);
  
  // Update engine current BPM when it changes
  useEffect(() => {
    engine.setCurrentBPM(bpm);
  }, [bpm, engine]);
  
  // Update engine note length when it changes
  useEffect(() => {
    engine.setNoteLength(noteLength);
  }, [noteLength, engine]);
  
  // Redraw waveform when BPM or note length changes (time-stretch visualization)
  useEffect(() => {
    if (breakbeatBuffer && mode === 'breakbeat') {
      console.log('Redrawing waveform - BPM:', bpm, 'Breakbeat BPM:', breakbeatBPM, 'Note Length:', noteLength, 'Num Slices:', numSlices);
      const waveformData = generateWaveform(breakbeatBuffer);
      setBreakbeatWaveform(waveformData);
    }
  }, [bpm, breakbeatBPM, noteLength, numSlices, breakbeatBuffer, mode, generateWaveform]);

  // keep refs in sync with state so the scheduler always reads latest values
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  useEffect(() => { gridStateRef.current = grid; }, [grid]);
  useEffect(() => { muteRef.current = mute; }, [mute]);
  useEffect(() => { volumesRef.current = volumes; }, [volumes]);
  useEffect(() => { sliceMuteRef.current = sliceMute; }, [sliceMute]);
  useEffect(() => { sliceVolumesRef.current = sliceVolumes; }, [sliceVolumes]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { numSlicesRef.current = numSlices; }, [numSlices]);

  // sync engine volumes immediately when changed
  useEffect(() => { 
    volumes.forEach((v, i) => engine.setVolume(i, v)); 
  }, [volumes, engine]);
  
  // sync engine slice volumes when changed
  useEffect(() => {
    if (mode === 'breakbeat') {
      sliceVolumes.forEach((v, i) => {
        if (i < engine.numRows) {
          engine.setVolume(i, v);
          engine.setMute(i, sliceMute[i] || false);
        }
      });
    }
  }, [sliceVolumes, sliceMute, mode, engine]);

  // Calculate step interval based on BPM and note length
  useEffect(() => {
    const noteDivisors = {
      '1/4': 1,    // quarter notes
      '1/8': 2,    // eighth notes
      '1/16': 4,   // sixteenth notes
      '1/32': 8    // thirty-second notes
    };
    const divisor = noteDivisors[noteLength] || 4;
    const sec = 60 / bpm / divisor;
    setStepIntervalSec(sec);
    
    // Calculate number of slices: assuming breakbeat is 1 bar (4 beats)
    // 1/4 notes = 4 slices per bar
    // 1/8 notes = 8 slices per bar
    // 1/16 notes = 16 slices per bar
    // 1/32 notes = 32 slices per bar
    const slicesPerBar = divisor * 4;
    setNumSlices(slicesPerBar);
    
    // Resize mute and volume arrays if needed
    setSliceMute(prev => {
      const newArray = new Array(slicesPerBar).fill(false);
      for (let i = 0; i < Math.min(prev.length, slicesPerBar); i++) {
        newArray[i] = prev[i];
      }
      return newArray;
    });
    setSliceVolumes(prev => {
      const newArray = new Array(slicesPerBar).fill(1);
      for (let i = 0; i < Math.min(prev.length, slicesPerBar); i++) {
        newArray[i] = prev[i];
      }
      return newArray;
    });
  }, [bpm, noteLength]);

  // initialize nextStepTime when starting
  useEffect(()=>{
    if (playing) {
      const audioCtx = audioCtxRef.current;
      absoluteTimeRef.current = audioCtx.currentTime;
      sequenceStartTimeRef.current = 0; // Start at sequence time 0
      nextStepTimeRef.current = audioCtx.currentTime + 0.05;
      currentColRef.current = 0;
      scheduler();
    } else {
      if (lookaheadTimerRef.current) { clearTimeout(lookaheadTimerRef.current); lookaheadTimerRef.current = null; }
      engine.cancelScheduled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Professional Web Audio scheduling system based on Chris Wilson's "A Tale of Two Clocks"
  // This ensures perfect timing by using the audio hardware clock and proper lookahead scheduling
  function scheduler() {
    // Use professional audio timing constants based on Chris Wilson's recommendations
    const scheduleAheadTime = 0.1; // 100ms lookahead for resilience
    const lookaheadFrequency = 25; // 25ms callback interval for responsiveness
    
    const audioCtx = audioCtxRef.current;
    
    // Ensure audio context is running
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const secPerStep = stepIntervalSec;

    while (nextStepTimeRef.current < audioCtx.currentTime + scheduleAheadTime) {
      // Check if there's a pending selection change at this beat
      if (pendingSelectionRef.current && 
          nextStepTimeRef.current >= pendingSelectionRef.current.switchTime) {
        // Apply the pending selection change
        const pendingChange = pendingSelectionRef.current;
        
        // Calculate where we are in the new pattern
        const elapsedSequenceTime = nextStepTimeRef.current - absoluteTimeRef.current;
        const newStepIndex = Math.floor(elapsedSequenceTime / secPerStep) % Math.max(1, pendingChange.selection.length);
        
        currentColRef.current = newStepIndex;
        setCurrentStep(newStepIndex);
        pendingSelectionRef.current = null; // Clear the pending change
      }

      // Read current selection
      const sel = selectionRef.current || selection;
      const stepIdx = currentColRef.current;
      
      // Schedule a step at nextStepTimeRef.current for column stepIdx
      scheduleStep(stepIdx, nextStepTimeRef.current);
      
      // Advance to next step using continuous audio time
      nextStepTimeRef.current += secPerStep;
      const len = Math.max(1, sel.length || 1);
      currentColRef.current = (currentColRef.current + 1) % len;
      setCurrentStep(prev => (prev + 1) % len);
    }

    // Schedule next callback with precise timing
    lookaheadTimerRef.current = setTimeout(scheduler, lookaheadFrequency);
  }

  function scheduleStep(colIndex, time) {
    // For each of the selection rows (4 for sample/midi, variable for breakbeat), check which cells are active
    const sel = selectionRef.current;
    if (!sel) return;
    const { startRow, startCol } = sel;
    const gridBuf = gridStateRef.current;
    const currentMode = modeRef.current;
    const currentNumSlices = numSlicesRef.current;
    const rowCount = currentMode === 'breakbeat' ? currentNumSlices : 4;
    
    if (currentMode === 'breakbeat') {
      // In breakbeat mode, find the highest active row (mutual exclusivity)
      // Lower row index = higher visual position (top of grid) = wins
      const m = sliceMuteRef.current || sliceMute;
      const vols = sliceVolumesRef.current || sliceVolumes;
      
      let winningSlice = -1;
      for (let r = 0; r < rowCount; r++) { // Start from bottom (lowest index = top visually)
        const row = startRow + r;
        const col = startCol + colIndex;
        if (row < 0 || row >= ROWS || col < 0 || col >= COLS) continue;
        const idx = row * COLS + col;
        if (gridBuf && gridBuf[idx]) {
          winningSlice = r;
          break; // Found the highest active slice (visually top)
        }
      }
      
      // Only trigger the winning slice
      if (winningSlice >= 0 && !m[winningSlice]) {
        console.log('Scheduling breakbeat slice:', { winningSlice, currentNumSlices, time, muted: m[winningSlice], volume: vols[winningSlice] });
        engine.setMute(winningSlice, false);
        engine.setVolume(winningSlice, vols[winningSlice]);
        engine.playBreakbeatSlice(winningSlice, currentNumSlices, time, 127);
      } else {
        console.log('Skipped slice - winning:', winningSlice, 'muted:', winningSlice >= 0 ? m[winningSlice] : 'N/A');
      }
    } else {
      // Sample or MIDI mode - original behavior
      const m = muteRef.current || mute;
      const vols = volumesRef.current || volumes;
      
      for (let r = 0; r < rowCount; r++) {
        const row = startRow + r;
        const col = startCol + colIndex;
        if (row < 0 || row >= ROWS || col < 0 || col >= COLS) continue;
        const idx = row * COLS + col;
        if (gridBuf && gridBuf[idx]) {
          engine.setMute(r, m[r]);
          engine.setVolume(r, vols[r]);
          engine.triggerRow(r, time, 127);
        }
      }
    }
  }

  function toggleCell(row, col) {
    const idx = row * COLS + col;
    const ng = new Uint8Array(grid);
    ng[idx] = ng[idx] ? 0 : 1;
    setGrid(ng);
  }

  // clamp current column when selection length changes while playing
  useEffect(() => {
    const len = Math.max(1, selection.length);
    if (currentColRef.current >= len) currentColRef.current = currentColRef.current % len;
    setCurrentStep(prev => prev % len);
  }, [selection.length]);

  // Handle selection changes with proper beat quantization
  useEffect(() => {
    if (!playing) return;
    
    const audioCtx = audioCtxRef.current;
    const audioNow = audioCtx.currentTime;
    const secPerStep = stepIntervalSec;
    
    // Calculate the next beat boundary
    // Find the next step time that's at least 25ms in the future to allow for processing
    const minSwitchTime = audioNow + 0.025;
    
    // Calculate how many steps have elapsed since the absolute start
    const elapsedTime = audioNow - absoluteTimeRef.current;
    const totalStepsElapsed = elapsedTime / secPerStep;
    const nextStepBoundary = Math.ceil(totalStepsElapsed) * secPerStep;
    const nextBeatTime = absoluteTimeRef.current + nextStepBoundary;
    
    // Use the next beat boundary that's far enough in the future
    const switchTime = Math.max(minSwitchTime, nextBeatTime);
    
    // Schedule the selection change for the next beat boundary
    pendingSelectionRef.current = {
      selection: { ...selection },
      switchTime: switchTime
    };
    
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.startCol, selection.startRow, selection.length]);  // mouse handlers for selection & toggling
  const mouseStateRef = useRef({ startRow: 0, startCol: 0, dragging: false });

  function onGridPointerDown(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const cellW = rect.width / COLS;
    const cellH = rect.height / ROWS;
    const col = Math.floor((e.clientX - rect.left) / cellW);
    const row = Math.floor((e.clientY - rect.top) / cellH);

    // If command/meta is pressed, don't change selection - just let click handler toggle the cell
    if (e.metaKey || e.ctrlKey) {
      return;
    }

    mouseStateRef.current = { startRow: row, startCol: col, dragging: true };
    setIsDragging(true);

    // start selection with top anchored so selection is 4 or 8 rows tall depending on mode
    const selectionHeight = mode === 'breakbeat' ? numSlices : 4;
    const startRowFixed = Math.max(0, Math.min(ROWS - selectionHeight, row));
    const newSelection = { active: true, startRow: startRowFixed, startCol: col, length: 4 };
    
    // Update visual immediately, schedule playback change for next beat
    scheduleSelectionChange(newSelection);
  }

  function onGridPointerMove(e) {
    if (!mouseStateRef.current.dragging) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cellW = rect.width / COLS;
    const col = Math.floor((e.clientX - rect.left) / cellW);

    const startCol = mouseStateRef.current.startCol;
    const len = Math.max(1, Math.abs(col - startCol) + 1);
    const startColFinal = Math.min(startCol, col);
    
    // Update visual selection immediately
    setSelection(sel => ({ ...sel, startCol: startColFinal, length: len }));
  }

  function onGridPointerUp(e) {
    mouseStateRef.current.dragging = false;
    setIsDragging(false);
    // if it was a click (no horizontal drag), ensure length at least 4
    setSelection(sel => {
      if (sel.length <= 1) {
        const newSel = { ...sel, length: 4 };
        // Schedule the final selection for playback
        scheduleSelectionChange(newSel);
        return newSel;
      }
      // Schedule the final selection for playback
      scheduleSelectionChange(sel);
      return sel;
    });
  }

  // clicking a cell with command/meta toggles it; otherwise just changes selection
  function onCellClick(row, col, ev) {
    // Command/Ctrl key toggles the cell
    if (ev.metaKey || ev.ctrlKey) {
      toggleCell(row, col);
      return;
    }
    // Without modifier, clicking just updates selection (handled by pointer events)
    // Do nothing here - selection is already updated by onGridPointerDown
  }

  function randomizeGrid() {
    // schedule randomize on next beat/time: we set a timeout to happen at nextStepTimeRef
    const audioNow = audioCtxRef.current.currentTime;
    const next = Math.max(audioNow + 0.02, nextStepTimeRef.current || audioNow + 0.05);
    const ms = Math.max(0, (next - audioNow) * 1000);
    setTimeout(()=>{ 
      const newGrid = new Uint8Array(ROWS*COLS); 
      for (let i=0;i<newGrid.length;i++) newGrid[i] = Math.random() < density ? 1 : 0; 
      setGrid(newGrid); 
    }, ms);
  }
  
  // Apply selection changes on beat quantization
  function scheduleSelectionChange(newSelection) {
    // Update visual selection immediately
    setSelection(newSelection);
    
    // Schedule the playback selection change at the next beat
    const audioNow = audioCtxRef.current.currentTime;
    const next = Math.max(audioNow + 0.02, nextStepTimeRef.current || audioNow + 0.05);
    const ms = Math.max(0, (next - audioNow) * 1000);
    
    setTimeout(() => {
      // Update the ref that the scheduler uses
      selectionRef.current = newSelection;
    }, ms);
  }
  
  // Apply density to current grid pattern
  function applyDensity(newDensity) {
    setDensity(newDensity);
    
    if (newDensity === 0) {
      // Fully empty
      setGrid(new Uint8Array(ROWS * COLS).fill(0));
    } else if (newDensity === 1) {
      // Fully filled
      setGrid(new Uint8Array(ROWS * COLS).fill(1));
    } else {
      // Calculate current fill ratio
      const currentFilled = grid.reduce((sum, val) => sum + val, 0);
      const currentTotal = ROWS * COLS;
      
      // Determine how many cells to add or remove
      const targetFilled = Math.round(newDensity * currentTotal);
      const diff = targetFilled - currentFilled;
      
      if (diff === 0) return;
      
      const newGrid = new Uint8Array(grid);
      
      if (diff > 0) {
        // Need to fill more cells - randomly turn off cells to on
        const offIndices = [];
        for (let i = 0; i < currentTotal; i++) {
          if (newGrid[i] === 0) offIndices.push(i);
        }
        
        // Shuffle and pick random cells to fill
        for (let i = offIndices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [offIndices[i], offIndices[j]] = [offIndices[j], offIndices[i]];
        }
        
        for (let i = 0; i < Math.min(diff, offIndices.length); i++) {
          newGrid[offIndices[i]] = 1;
        }
      } else {
        // Need to remove cells - randomly turn on cells to off
        const onIndices = [];
        for (let i = 0; i < currentTotal; i++) {
          if (newGrid[i] === 1) onIndices.push(i);
        }
        
        // Shuffle and pick random cells to clear
        for (let i = onIndices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [onIndices[i], onIndices[j]] = [onIndices[j], onIndices[i]];
        }
        
        for (let i = 0; i < Math.min(-diff, onIndices.length); i++) {
          newGrid[onIndices[i]] = 0;
        }
      }
      
      setGrid(newGrid);
    }
  }
  
  // Handle density slider with immediate visual feedback and delayed application
  function handleDensityChange(displayValue) {
    setDensityDisplay(displayValue);
    
    // Debounce the actual density application
    if (window.densityTimeout) clearTimeout(window.densityTimeout);
    window.densityTimeout = setTimeout(() => {
      applyDensity(displayValue);
    }, 100); // 100ms debounce
  }

  // sample loading
  async function handleSampleDrop(rowIndex, file) {
    if (!file) return;
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioCtxRef.current.decodeAudioData(arrayBuffer.slice(0));
    engine.loadSample(rowIndex, audioBuffer);
    setSamplesInfo(prev => { const copy = prev.slice(); copy[rowIndex] = { name: file.name, len: Math.round(audioBuffer.duration*1000) }; return copy; });
  }

  function handleFileInput(e, rowIndex) { const f = e.target.files && e.target.files[0]; if (f) handleSampleDrop(rowIndex,f); }

  // Breakbeat loading and waveform generation
  async function handleBreakbeatDrop(file) {
    if (!file) return;
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioCtxRef.current.decodeAudioData(arrayBuffer.slice(0));
    setBreakbeatBuffer(audioBuffer);
    engine.setBreakbeatBuffer(audioBuffer);
    
    // Extract BPM from filename if present (look for numbers between 1-800)
    const filename = file.name;
    const bpmMatch = filename.match(/\b([1-9]\d{0,2}|[1-7]\d{2}|800)\b/g);
    if (bpmMatch) {
      // Filter to only valid BPM range (typically 60-200, but allow 1-800 as requested)
      const validBPMs = bpmMatch.map(Number).filter(n => n >= 1 && n <= 800);
      if (validBPMs.length > 0) {
        // Use the most likely BPM (prefer values in typical range 60-200)
        const likelyBPM = validBPMs.find(n => n >= 60 && n <= 200) || validBPMs[0];
        setBreakbeatBPM(likelyBPM);
        setBpm(likelyBPM);
        // Update engine immediately
        engine.setBreakbeatBPM(likelyBPM);
        engine.setCurrentBPM(likelyBPM);
      }
    }
    
    // Generate waveform data for visualization
    const waveformData = generateWaveform(audioBuffer);
    setBreakbeatWaveform(waveformData);
  }
  
  function handleBreakbeatFileInput(e) { const f = e.target.files && e.target.files[0]; if (f) handleBreakbeatDrop(f); }

  // simple UI for MIDI outputs
  const [midiOutputs, setMidiOutputs] = useState([]);
  useEffect(()=>{
    if (navigator.requestMIDIAccess) {
      navigator.requestMIDIAccess().then(m=>{ const outs = Array.from(m.outputs.values()); setMidiOutputs(outs); if (outs.length>0) engine.setMidiOutput(outs[0]); });
    }
  }, [engine]);

  // Preload default samples on mount
  useEffect(() => {
    const sampleFiles = [
      'samples/1_kick.wav',
      'samples/2_snare.wav',
      'samples/3_crash.wav',
      'samples/4_chh2.wav'
    ];
    
    async function loadSamples() {
      for (let i = 0; i < sampleFiles.length; i++) {
        try {
          const response = await fetch(sampleFiles[i]);
          if (!response.ok) continue;
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await audioCtxRef.current.decodeAudioData(arrayBuffer);
          engine.loadSample(i, audioBuffer);
          setSamplesInfo(prev => {
            const copy = prev.slice();
            copy[i] = { name: sampleFiles[i].split('/').pop(), len: Math.round(audioBuffer.duration * 1000) };
            return copy;
          });
        } catch (err) {
          console.warn(`Failed to load sample ${sampleFiles[i]}:`, err);
        }
      }
    }
    
    loadSamples();
  }, [engine]);

  // Initialize with a random pattern on mount
  useEffect(() => {
    const newGrid = new Uint8Array(ROWS * COLS);
    for (let i = 0; i < newGrid.length; i++) {
      newGrid[i] = Math.random() < density ? 1 : 0;
    }
    setGrid(newGrid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in an input field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
        return;
      }

      switch(e.key) {
        case ' ': // Spacebar - play/stop
          e.preventDefault();
          setPlaying(p => !p);
          break;
        
        case '+':
        case '=': // Also handle = key (same key as + without shift)
          e.preventDefault();
          setBpm(b => {
            const newBpm = Math.min(999, (typeof b === 'number' ? b : 120) + 10);
            if (mode === 'breakbeat') setBreakbeatBPM(newBpm);
            return newBpm;
          });
          break;
        
        case '-':
        case '_': // Also handle - key
          e.preventDefault();
          setBpm(b => {
            const newBpm = Math.max(1, (typeof b === 'number' ? b : 120) - 10);
            if (mode === 'breakbeat') setBreakbeatBPM(newBpm);
            return newBpm;
          });
          break;
        
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
          e.preventDefault();
          const voiceIndex = parseInt(e.key) - 1;
          const maxVoices = mode === 'breakbeat' ? numSlices : 4;
          if (voiceIndex < maxVoices) {
            if (mode === 'breakbeat') {
              setSliceMute(m => {
                const newMute = [...m];
                newMute[voiceIndex] = !newMute[voiceIndex];
                return newMute;
              });
            } else {
              setMute(m => {
                const newMute = [...m];
                newMute[voiceIndex] = !newMute[voiceIndex];
                return newMute;
              });
            }
          }
          break;
        
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, numSlices]);

  // small grid renderer
  const gridRef = useRef(null);
  
  // Helper function to get color for a row within selection
  const getRowColor = (rowIndexInSelection, totalRows) => {
    // Generate shades of blue from light to dark
    // Row 0 (top) = lightest, last row = darkest
    // We want visible blue colors, not too light
    const intensity = 0.3 + (rowIndexInSelection / totalRows) * 0.7; // Range from 0.3 (light) to 1.0 (dark)
    const r = Math.round(0 + (255 - 0) * (1 - intensity)); // More red = lighter
    const g = Math.round(102 + (255 - 102) * (1 - intensity)); // More green = lighter
    const b = 255; // Keep blue at max
    return { r, g, b, intensity };
  };

  // Calculate the optimal size for the grid based on viewport
  const gridSize = controlsCollapsed 
    ? 'min(100vw - 24px, calc(100vh - 80px))'  
    : 'min(calc(100vw - 500px), calc(100vh - 24px))';

  // Define styles for themed UI components
  const uiStyles = {
    container: {
      fontFamily: "'Courier New', monospace", 
      padding: 12, 
      background: 'rgb(0, 0, 255)',
      color: 'white',
      minHeight: '100vh',
      transition: 'all 0.3s ease',
      boxSizing: 'border-box'
    },
    flexContainer: {
      display: 'flex', 
      gap: 12,
      flexDirection: controlsCollapsed ? 'column' : 'row',
      height: 'calc(100vh - 24px)',
      boxSizing: 'border-box'
    },
    gridContainer: {
      width: gridSize,
      height: gridSize,
      border: '1px solid rgb(255, 255, 255)',
      borderRadius: '0px',
      position: 'relative',
      transition: 'all 0.3s ease',
      boxSizing: 'border-box',
      flexShrink: 0
    },
    controlPanel: {
      width: controlsCollapsed ? '100%' : 'calc(100vw - 24px - 12px - ' + gridSize + ')',
      maxWidth: controlsCollapsed ? '100%' : '500px',
      minWidth: controlsCollapsed ? '100%' : '360px',
      background: 'rgb(0, 0, 255)',
      borderRadius: '0px',
      padding: '12px',
      border: '1px solid rgb(255, 255, 255)',
      transition: 'all 0.3s ease',
      overflow: controlsCollapsed ? 'hidden' : 'auto',
      maxHeight: controlsCollapsed ? '60px' : gridSize,
      height: controlsCollapsed ? '60px' : gridSize,
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column'
    },
    controlHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: controlsCollapsed ? 0 : 12,
      flexShrink: 0
    },
    controlContent: {
      overflowY: 'auto',
      flexGrow: 1,
      paddingRight: '8px'
    },
    heading: {
      margin: 0,
      color: 'white',
      fontSize: '18px',
      fontWeight: 'bold'
    },
    toggleButton: {
      background: 'rgba(255, 255, 255, 0.2)',
      color: 'white',
      border: '1px solid rgba(255, 255, 255, 0.4)',
      padding: '6px 12px',
      borderRadius: '4px',
      cursor: 'pointer',
      fontWeight: 'bold',
      transition: 'all 0.2s ease',
      userSelect: 'none',
      outline: 'none'
    },
    input: {
      background: 'rgba(255, 255, 255, 0.1)',
      border: '1px solid rgb(255, 255, 255)',
      borderRadius: '0px',
      color: 'white',
      padding: '4px 6px',
      fontFamily: "'Courier New', monospace"
    },
    button: {
      background: 'rgba(255, 255, 255, 0.2)',
      color: 'white',
      border: '1px solid rgb(255, 255, 255)',
      padding: '4px 8px',
      borderRadius: '0px',
      cursor: 'pointer',
      transition: 'background 0.2s ease',
      fontFamily: "'Courier New', monospace"
    },
    select: {
      background: 'rgba(255, 255, 255, 0.1)',
      border: '1px solid rgb(255, 255, 255)',
      borderRadius: '0px',
      color: 'white',
      padding: '4px 6px',
      fontFamily: "'Courier New', monospace"
    },
    slider: {
      accentColor: 'white',
      background: 'gray'
    },
    label: {
      color: 'white',
      marginRight: '8px'
    },
    section: {
      marginBottom: 16,
      borderTop: '1px solid rgba(255, 255, 255, 0.2)',
      paddingTop: 12
    }
  };

  return (
    <div style={uiStyles.container}>
      <div style={uiStyles.flexContainer}>
        <div 
          style={uiStyles.gridContainer}
          onPointerDown={onGridPointerDown}
          onPointerMove={onGridPointerMove}
          onPointerUp={onGridPointerUp}
          ref={gridRef}>

          {/* grid cells as a CSS grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gridTemplateRows: `repeat(${ROWS}, 1fr)`, width: '100%', height: '100%'
          }}>
            {Array.from({ length: ROWS }).map((_, r) => (
              Array.from({ length: COLS }).map((__, c) => {
                const idx = r * COLS + c;
                const on = !!grid[idx];
                const selectionHeight = mode === 'breakbeat' ? numSlices : 4;
                const inSelection = selection.active && r >= selection.startRow && r < selection.startRow + selectionHeight && c >= selection.startCol && c < selection.startCol + selection.length;
                
                // Check if this column is the currently playing step
                const isCurrentStep = playing && inSelection && c === selection.startCol + currentStep;
                
                // Only show border on the outer edges of the selection
                const isTopEdge = inSelection && r === selection.startRow;
                const isBottomEdge = inSelection && r === selection.startRow + selectionHeight - 1;
                const isLeftEdge = inSelection && c === selection.startCol;
                const isRightEdge = inSelection && c === selection.startCol + selection.length - 1;
                
                const borderStyle = {
                  borderTop: isTopEdge ? '2px solid rgba(0,120,255,0.9)' : 'none',
                  borderBottom: isBottomEdge ? '2px solid rgba(0,120,255,0.9)' : 'none',
                  borderLeft: isLeftEdge ? '2px solid rgba(0,120,255,0.9)' : 'none',
                  borderRight: isRightEdge ? '2px solid rgba(0,120,255,0.9)' : 'none',
                };
                
                // Calculate row index within selection for color coding
                const rowIndexInSelection = inSelection ? r - selection.startRow : -1;
                const rowColor = rowIndexInSelection >= 0 ? getRowColor(rowIndexInSelection, selectionHeight) : null;
                
                // Add visual indicator for current playing step
                let background = on ? '#000' : '#fff';
                if (inSelection && rowColor && on) {
                  // Color-coded tint ONLY for active (black) cells
                  // Use the full color brightness (not darkened)
                  background = `rgb(${rowColor.r}, ${rowColor.g}, ${rowColor.b})`;
                }
                if (isCurrentStep) {
                  // Green tint for playing column (overrides blue)
                  background = on ? '#00ff00' : '#e0ffe0';
                }
                
                return (
                  <div key={`${r}-${c}`}
                    onClick={(ev)=>onCellClick(r,c,ev)}
                    style={{
                      width: '100%', height: '100%', boxSizing: 'border-box',
                      background,
                      ...borderStyle,
                    }} />
                );
              })
            ))}
          </div>
        </div>

        <div style={uiStyles.controlPanel}>
          <div style={uiStyles.controlHeader}>
            <h3 style={uiStyles.heading}>
              Drum Grid Sequencer
            </h3>
            <button 
              onClick={() => setControlsCollapsed(prev => !prev)} 
              style={uiStyles.toggleButton}
              onMouseOver={(e) => e.target.style.background = 'rgba(255, 255, 255, 0.3)'}
              onMouseOut={(e) => e.target.style.background = 'rgba(255, 255, 255, 0.2)'}
            >
              {controlsCollapsed ? 'Show Controls' : 'Hide Controls'}
            </button>
          </div>
          
          {!controlsCollapsed && (
            <div style={uiStyles.controlContent}>
              <div style={{ marginBottom: 8 }}>
                <label style={uiStyles.label}>BPM: <input type="number" min={1} max={999} value={bpm} onChange={e=>{
              const val = e.target.value;
              // Allow empty string for user to type
              if (val === '') {
                setBpm('');
                return;
              }
              const num = Number(val);
              if (!isNaN(num)) {
                const clamped = Math.max(1, Math.min(999, num));
                setBpm(clamped);
                if (mode === 'breakbeat') {
                  setBreakbeatBPM(clamped);
                }
              }
            }} onBlur={e=>{
              // On blur, ensure we have a valid number
              if (bpm === '' || isNaN(bpm)) {
                setBpm(120);
                if (mode === 'breakbeat') setBreakbeatBPM(120);
              }
            }} style={{...uiStyles.input, width: 50}} /></label>
            
            <label style={{ marginLeft: 12 }}>Note Length: 
              <select value={noteLength} onChange={e=>setNoteLength(e.target.value)} style={Object.assign({}, uiStyles.select, {marginLeft: 4, width: '50px'})}>
                <option value="1/4">1/4</option>
                <option value="1/8">1/8</option>
                <option value="1/16">1/16</option>
                <option value="1/32">1/32</option>
              </select>
            </label>
            
            <button 
              onClick={()=>setPlaying(p=>!p)} 
              style={{
                ...uiStyles.button, 
                marginLeft: 8,
                position: 'relative',
                overflow: 'hidden',
                background: playing 
                  ? `rgba(0, 255, 0, ${0.2 + pulseAnimation * 0.3})` 
                  : uiStyles.button.background,
                boxShadow: playing 
                  ? `0 0 ${8 + pulseAnimation * 12}px rgba(0, 255, 0, ${0.4 + pulseAnimation * 0.4})` 
                  : 'none',
                borderColor: playing 
                  ? `rgba(0, 255, 0, ${0.6 + pulseAnimation * 0.4})` 
                  : uiStyles.button.border.split(' ')[2], // Extract the color from border string
                transition: playing ? 'none' : 'background 0.2s ease'
              }}
            >
              {playing ? 'Stop' : 'Play'}
            </button>
            <button onClick={randomizeGrid} style={{...uiStyles.button, marginLeft: 8}}>New Seed</button>
            <div style={{ marginTop: 6 }}>Current step: {currentStep + 1}/{selection.length}</div>
            
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: '180px' }}>
                <span style={uiStyles.label}>Density:</span>
                <input 
                  type="range" 
                  min={0} 
                  max={1} 
                  step={0.01} 
                  value={densityDisplay} 
                  onChange={e=>handleDensityChange(Number(e.target.value))} 
                  style={{...uiStyles.slider, width: 150}}
                />
                <span style={{...uiStyles.label, minWidth: 40}}>{Math.round(densityDisplay * 100)}%</span>
              </label>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label>Mode: </label>
            <select value={mode} onChange={e=>setMode(e.target.value)} style={uiStyles.select}>
              <option value="sample">Sample</option>
              <option value="midi">MIDI</option>
              <option value="breakbeat">Breakbeat Slicer</option>
            </select>
            {mode === 'midi' && (
              <div style={{ marginTop: 6 }}>
                <label style={uiStyles.label}>Channel: <input type="number" min={1} max={16} defaultValue={engine.midiChannel} onChange={e=>engine.setMidiChannel(Number(e.target.value)||1)} style={Object.assign({}, uiStyles.input, {width: 40})} /></label>
                <div style={{ marginTop: 6, color: 'white' }}>
                  <label style={uiStyles.label}>MIDI Output: <select onChange={e=>{ const id=e.target.value; const out = midiOutputs.find(o=>o.id===id); if (out) engine.setMidiOutput(out); }} style={uiStyles.select}>
                    {midiOutputs.map(o => <option value={o.id} key={o.id}>{o.name || o.id}</option>)}
                  </select></label>
                </div>
              </div>
            )}
            {mode === 'breakbeat' && (
              <div style={{ marginTop: 6 }}>
                <div style={{ marginBottom: 8 }}>
                  <label style={uiStyles.label}>
                  Breakbeat BPM: 
                  <input 
                    type="number" 
                    min={1} 
                    max={999} 
                    value={breakbeatBPM}
                    style={Object.assign({}, uiStyles.input, {width: 50})}
                    onChange={e => { 
                      const val = e.target.value;
                      if (val === '') {
                        setBreakbeatBPM('');
                        return;
                      }
                      const num = Number(val);
                      if (!isNaN(num)) {
                        const clamped = Math.max(1, Math.min(999, num));
                        setBreakbeatBPM(clamped); 
                        setBpm(clamped);
                      }
                    }} 
                    onBlur={e => {
                      if (breakbeatBPM === '' || isNaN(breakbeatBPM)) {
                        setBreakbeatBPM(120);
                        setBpm(120);
                      }
                    }} 
                  />
                </label>
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: 'white' }}>
                    <input
                      type="checkbox"
                      checked={breakbeatOneShot}
                      onChange={(e) => {
                        setBreakbeatOneShot(e.target.checked);
                        engine.setBreakbeatOneShot(e.target.checked);
                      }}
                      style={{ cursor: 'pointer' }}
                    />
                    <span>One-shot mode (stop at note boundary)</span>
                  </label>
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={uiStyles.label}>
                    Pitch: {breakbeatPitch > 0 ? '+' : ''}{breakbeatPitch} st
                    <input
                      type="range"
                      min="-12"
                      max="12"
                      step="1"
                      value={breakbeatPitch}
                      onChange={(e) => {
                        const newPitch = parseInt(e.target.value);
                        setBreakbeatPitch(newPitch);
                        engine.setBreakbeatPitch(newPitch);
                      }}
                      style={{...uiStyles.slider, width: '200px', marginLeft: 8, verticalAlign: 'middle' }}
                    />
                  </label>
                </div>
                <div style={{ marginBottom: 8 }}>
                  <input type="file" accept="audio/*" onChange={handleBreakbeatFileInput} style={{
                    color: 'white',
                    background: 'rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '4px',
                    padding: '4px',
                    margin: '4px 0'
                  }} />
                </div>
                {breakbeatWaveform && (
                  <div style={{ width: '100%', height: 80, border: '1px solid rgb(255, 255, 255)', position: 'relative', background: 'rgba(50, 50, 255, 0.5)' }}>
                    <svg width="100%" height="80" viewBox="0 0 200 80" preserveAspectRatio="none" style={{ display: 'block' }}>
                      {/* Center line */}
                      <line x1="0" y1="40" x2="200" y2="40" stroke="rgba(255, 255, 255, 0.5)" strokeWidth="0.5" />
                      
                      {/* Waveform as filled area (CDJ style) */}
                      <path
                        d={(() => {
                          const topPath = breakbeatWaveform.map((v, i) => {
                            const x = (i / breakbeatWaveform.length) * 200;
                            const y = 40 + (v.min * 35); // Top part (negative values go up)
                            return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
                          }).join(' ');
                          
                          const bottomPath = breakbeatWaveform.slice().reverse().map((v, i) => {
                            const x = ((breakbeatWaveform.length - 1 - i) / breakbeatWaveform.length) * 200;
                            const y = 40 + (v.max * 35); // Bottom part (positive values go down)
                            return `L ${x} ${y}`;
                          }).join(' ');
                          
                          return topPath + ' ' + bottomPath + ' Z';
                        })()}
                        fill="rgba(255, 255, 255, 0.6)"
                        stroke="rgba(255, 255, 255, 0.9)"
                        strokeWidth="0.5"
                      />
                      
                      {/* Slice markers based on numSlices */}
                      {Array.from({ length: numSlices + 1 }).map((_, i) => (
                        <line
                          key={i}
                          x1={(i / numSlices) * 200}
                          y1="0"
                          x2={(i / numSlices) * 200}
                          y2="80"
                          stroke={i === 0 || i === numSlices ? 'white' : 'rgba(255, 255, 255, 0.7)'}
                          strokeWidth={i === 0 || i === numSlices ? '1' : '0.5'}
                        />
                      ))}
                      
                      {/* Visual flash for currently playing slice */}
                      {currentlyPlayingSlice >= 0 && currentlyPlayingSlice < numSlices && (
                        <rect
                          key={sliceFlashKey}
                          x={(currentlyPlayingSlice / numSlices) * 200}
                          y="0"
                          width={(1 / numSlices) * 200}
                          height="80"
                          fill="rgba(255, 255, 255, 0.5)"
                          style={{ 
                            animation: 'sliceFlash 0.1s ease-out',
                            pointerEvents: 'none'
                          }}
                        />
                      )}
                    </svg>
                    <style>{`
                      @keyframes sliceFlash {
                        0% { opacity: 1; }
                        100% { opacity: 0; }
                      }
                    `}</style>
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ marginTop: 14 }}>
            <h4 style={{ 
              color: 'white', 
              borderBottom: '1px solid rgba(255, 255, 255, 0.2)', 
              paddingBottom: '8px',
              marginTop: '20px',
              marginBottom: '12px'
            }}>{mode === 'breakbeat' ? 'Slices' : 'Samples / Voices'}</h4>
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', 
              gap: '8px',
              marginTop: '12px'
            }}>
            {Array.from({ length: mode === 'breakbeat' ? numSlices : 4 }).map((_, i) => {
              const isPlayingSlice = mode === 'breakbeat' && currentlyPlayingSlice === i;
              const isPlayingRow = (mode === 'sample' || mode === 'midi') && currentlyPlayingRow === i;
              const isPlaying = isPlayingSlice || isPlayingRow;
              const totalRows = mode === 'breakbeat' ? numSlices : 4;
              const rowColor = getRowColor(i, totalRows);
              const colorIndicator = `rgb(${rowColor.r}, ${rowColor.g}, ${rowColor.b})`;
              
              return (
                <div key={i} style={{ 
                  border: '1px solid rgb(255, 255, 255)', 
                  padding: 8, 
                  background: isPlaying ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.05)',
                  borderRadius: '0px',
                  transition: 'background 0.1s ease',
                  boxShadow: isPlaying ? '0 0 8px rgba(255, 255, 255, 0.4)' : 'none'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: isPlaying ? 'bold' : 'normal' }}>
                      <div style={{ 
                        width: 16, 
                        height: 16, 
                        backgroundColor: colorIndicator,
                        border: '1px solid #666',
                        borderRadius: 2,
                        flexShrink: 0
                      }} />
                      <span>
                        {mode === 'breakbeat' ? `Slice ${i+1}` : `Voice ${i+1}`}
                      </span>
                    </div>
                    <div>
                      <label style={uiStyles.label}>Mute <input type="checkbox" checked={mode === 'breakbeat' ? sliceMute[i] : mute[i]} onChange={e=>{ if (mode === 'breakbeat') { const m = [...sliceMute]; m[i]=e.target.checked; setSliceMute(m); } else { const m = [...mute]; m[i]=e.target.checked; setMute(m); } }} /></label>
                      <label style={{...uiStyles.label, marginLeft: 8}}>Vol <input type="range" min={0} max={1} step={0.01} value={mode === 'breakbeat' ? sliceVolumes[i] : volumes[i]} style={{...uiStyles.slider}} onChange={e=>{ if (mode === 'breakbeat') { const v = [...sliceVolumes]; v[i]=Number(e.target.value); setSliceVolumes(v); engine.setVolume(i, Number(e.target.value)); } else { const v = [...volumes]; v[i]=Number(e.target.value); setVolumes(v); engine.setVolume(i, Number(e.target.value)); } }} /></label>
                    </div>
                  </div>
                  {mode !== 'breakbeat' && (
                    <div style={{ marginTop: 6 }}>
                      {mode === 'midi' ? (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <label style={{...uiStyles.label, fontSize: 12}}>
                            MIDI Note: 
                            <input 
                              type="number" 
                              min={0} 
                              max={127} 
                              value={midiNotes[i]} 
                              onChange={e=>{ 
                                const note = Math.max(0, Math.min(127, Number(e.target.value) || 0));
                                const newNotes = [...midiNotes]; 
                                newNotes[i] = note; 
                                setMidiNotes(newNotes); 
                                engine.setMidiNoteForRow(i, note);
                              }} 
                              style={{...uiStyles.input, width: 40, marginLeft: 4}} 
                            />
                          </label>
                          <div style={{ fontSize: 11, color: 'rgba(255, 255, 255, 0.7)' }}>({['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][midiNotes[i] % 12]}{Math.floor(midiNotes[i] / 12) - 1})</div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input type="file" accept="audio/*" onChange={(e)=>handleFileInput(e,i)} style={{
                            color: 'white',
                            background: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '4px',
                            padding: '4px',
                            margin: '4px 0'
                          }} />
                          <div style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.85)' }}>{samplesInfo[i] ? `${samplesInfo[i].name} (${samplesInfo[i].len}ms)` : 'No sample loaded'}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, color: 'white' }}>
            Tips: Click cells to toggle. Click+drag horizontally to set selection length. Selection is fixed 4 rows tall. Play starts scheduling steps; samples play via WebAudio. MIDI mode will use selected MIDI output or fallback to oscillator.
          </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

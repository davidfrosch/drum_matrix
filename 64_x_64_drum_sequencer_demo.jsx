import React, { useEffect, useRef, useState } from 'react';

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

    this.sampleBuffers = new Array(this.numRows).fill(null);
    this.muted = new Array(this.numRows).fill(false);
    this.volumes = new Array(this.numRows).fill(1.0);
    this.midiNotes = [36, 38, 42, 46].slice(0, this.numRows);

    this.midiAccess = null;
    this.midiOutput = null;
    this.midiChannel = 1;

    this._scheduledTimeouts = new Set();

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

  async _resumeAudioContextIfNeeded(){ if (this.audioCtx.state==='suspended') await this.audioCtx.resume(); }
  _bindResumeOnGesture(){ if (this.audioCtx && this.audioCtx.state==='suspended') this.audioCtx.resume().catch(()=>{}); if (navigator.requestMIDIAccess && !this.midiAccess) navigator.requestMIDIAccess({ sysex:false }).then(m=>this.midiAccess=m).catch(()=>{}); }

  triggerRow(rowIndex, when=null, velocity=127){ if (rowIndex<0||rowIndex>=this.numRows) return; if (this.muted[rowIndex]) return; const playTime = (typeof when==='number')? when : this.audioCtx.currentTime; this._resumeAudioContextIfNeeded().then(()=>{ if (this.mode==='sample') this._playSample(rowIndex, playTime, velocity); else this._playMidiNote(rowIndex, playTime, velocity); }).catch(()=>{}); }

  cancelScheduled(){ for (const id of this._scheduledTimeouts) clearTimeout(id); this._scheduledTimeouts.clear(); }

  _playSample(rowIndex, time, velocity){ const buffer = this.sampleBuffers[rowIndex]; if (!buffer){ this._playOscillatorFallback(rowIndex, time, velocity); return; }
    const source = this.audioCtx.createBufferSource(); source.buffer = buffer; const gain = this.audioCtx.createGain(); const velocityFactor = (velocity/127)||1.0; const targetGain = this.volumes[rowIndex]*velocityFactor; gain.gain.setValueAtTime(targetGain, time);
    const fadeStart = time + Math.max(0.001, this.defaultNoteLength*0.6); const fadeDuration = Math.max(0.01, this.defaultNoteLength*0.4);
    gain.gain.setValueAtTime(targetGain, fadeStart);
    gain.gain.linearRampToValueAtTime(0.0001, fadeStart + fadeDuration);
    source.connect(gain); gain.connect(this.audioCtx.destination);
    source.start(time);
    const stopTime = Math.min(time + buffer.duration, fadeStart + fadeDuration + 0.05);
    source.stop(stopTime);
    source.onended = () => { try{ source.disconnect() }catch(e){} try{ gain.disconnect() }catch(e){} };
  }

  _playMidiNote(rowIndex, time, velocity){ const noteNumber = this.midiNotes[rowIndex]|0; const vel = Math.max(0,Math.min(127,velocity|0)); const chan = ((this.midiChannel-1)&0xF); const statusOn = 0x90|chan; const statusOff = 0x80|chan; const noteOnMsg=[statusOn,noteNumber,vel]; const noteOffMsg=[statusOff,noteNumber,0]; const nowAudio = this.audioCtx.currentTime; const nowPerf = performance.now()/1000; const perfToAudioOffset = nowPerf - nowAudio; const noteOnPerfMs = (time + perfToAudioOffset)*1000; const noteOffPerfMs = (time + this.defaultNoteLength + perfToAudioOffset)*1000;
    if (this.midiOutput && typeof this.midiOutput.send==='function'){
      try{ this.midiOutput.send(noteOnMsg, Math.round(noteOnPerfMs)); this.midiOutput.send(noteOffMsg, Math.round(noteOffPerfMs)); }
      catch(e){ this.midiOutput.send(noteOnMsg); const msDelay=Math.max(0,(this.defaultNoteLength)*1000); const id=setTimeout(()=>{ try{ this.midiOutput.send(noteOffMsg) }catch(e){} this._scheduledTimeouts.delete(id); }, msDelay); this._scheduledTimeouts.add(id); }
    } else { this._playOscillatorFallback(rowIndex, time, velocity); }
  }

  _playOscillatorFallback(rowIndex, time, velocity){ const osc = this.audioCtx.createOscillator(); const gain = this.audioCtx.createGain(); const midiNote = (this.midiNotes[rowIndex]||60); const freq = 440 * Math.pow(2, (midiNote - 69)/12); osc.frequency.setValueAtTime(freq, time); osc.type='sine'; const velocityFactor=(velocity/127)||1.0; const initGain=Math.max(0,Math.min(1,this.volumes[rowIndex]*velocityFactor*0.15)); gain.gain.setValueAtTime(0.0001, time); gain.gain.linearRampToValueAtTime(initGain, time+0.005); const releaseStart = time + Math.max(0.01, this.defaultNoteLength*0.6); gain.gain.setValueAtTime(initGain, releaseStart); gain.gain.linearRampToValueAtTime(0.0001, releaseStart + Math.max(0.02, this.defaultNoteLength*0.4)); osc.connect(gain); gain.connect(this.audioCtx.destination); osc.start(time); const stopAt = releaseStart + Math.max(0.02, this.defaultNoteLength*0.4) + 0.05; osc.stop(stopAt); osc.onended = ()=>{ try{ osc.disconnect() }catch(e){} try{ gain.disconnect() }catch(e){} };
  }
}

// -------------------- React UI --------------------
export default function SequencerDemo() {
  const ROWS = 64, COLS = 64;
  const [grid, setGrid] = useState(() => new Uint8Array(ROWS * COLS).fill(0));
  const [selection, setSelection] = useState({ active: false, startRow: 0, startCol: 0, length: 4 });
  const [isDragging, setIsDragging] = useState(false);
  const [engine] = useState(() => new SequencerEngine({ mode: 'sample', numRows: 4 }));
  const audioCtxRef = useRef(engine.audioCtx);

  const [mode, setMode] = useState('sample');
  const [bpm, setBpm] = useState(120);
  const [playing, setPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [stepIntervalSec, setStepIntervalSec] = useState(() => 60 / 120 / 4); // 16th notes
  const [samplesInfo, setSamplesInfo] = useState(new Array(4).fill(null));
  const [mute, setMute] = useState([false,false,false,false]);
  const [volumes, setVolumes] = useState([1,1,1,1]);

  // scheduling refs
  const nextStepTimeRef = useRef(0);
  const currentColRef = useRef(0);
  const lookaheadTimerRef = useRef(null);

  useEffect(()=>{ engine.setMode(mode); }, [mode, engine]);

  useEffect(()=>{ const sec = 60 / bpm / 4; setStepIntervalSec(sec); }, [bpm]);

  // initialize nextStepTime when starting
  useEffect(()=>{
    if (playing) {
      nextStepTimeRef.current = audioCtxRef.current.currentTime + 0.05;
      currentColRef.current = 0;
      scheduler();
    } else {
      if (lookaheadTimerRef.current) { clearTimeout(lookaheadTimerRef.current); lookaheadTimerRef.current = null; }
      engine.cancelScheduled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  function scheduler() {
    const scheduleAheadTime = 0.2;
    const audioCtx = audioCtxRef.current;
    const secPerStep = stepIntervalSec;

    while (nextStepTimeRef.current < audioCtx.currentTime + scheduleAheadTime) {
      // schedule a step at nextStepTimeRef.current for column currentColRef.current
      scheduleStep(currentColRef.current, nextStepTimeRef.current);
      nextStepTimeRef.current += secPerStep;
      currentColRef.current = (currentColRef.current + 1) % selection.length;
      setCurrentStep(prev => (prev + 1) % Math.max(1, selection.length));
    }

    lookaheadTimerRef.current = setTimeout(scheduler, 25);
  }

  function scheduleStep(colIndex, time) {
    // For each of the 4 selection rows (top->down), check whether corresponding cell is active
    const { startRow, startCol } = selection;
    for (let r = 0; r < 4; r++) {
      const row = startRow + r;
      const col = startCol + colIndex;
      if (row < 0 || row >= ROWS || col < 0 || col >= COLS) continue;
      const idx = row * COLS + col;
      if (grid[idx]) {
        // trigger engine row r (0..3)
        engine.setMute(r, mute[r]);
        engine.setVolume(r, volumes[r]);
        engine.triggerRow(r, time, 127);
      }
    }
  }

  function toggleCell(row, col) {
    const idx = row * COLS + col;
    const ng = new Uint8Array(grid);
    ng[idx] = ng[idx] ? 0 : 1;
    setGrid(ng);
  }

  // mouse handlers for selection & toggling
  const mouseStateRef = useRef({ startRow: 0, startCol: 0, dragging: false });

  function onGridPointerDown(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const cellW = rect.width / COLS;
    const cellH = rect.height / ROWS;
    const col = Math.floor((e.clientX - rect.left) / cellW);
    const row = Math.floor((e.clientY - rect.top) / cellH);

    mouseStateRef.current = { startRow: row, startCol: col, dragging: true };
    setIsDragging(true);

    // start selection with top anchored so selection is 4 rows tall
    const startRowFixed = Math.max(0, Math.min(ROWS - 4, row));
    setSelection({ active: true, startRow: startRowFixed, startCol: col, length: 4 });
  }

  function onGridPointerMove(e) {
    if (!mouseStateRef.current.dragging) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cellW = rect.width / COLS;
    const col = Math.floor((e.clientX - rect.left) / cellW);

    const startCol = mouseStateRef.current.startCol;
    const len = Math.max(1, Math.abs(col - startCol) + 1);
    const startColFinal = Math.min(startCol, col);
    setSelection(sel => ({ ...sel, startCol: startColFinal, length: len }));
  }

  function onGridPointerUp(e) {
    mouseStateRef.current.dragging = false;
    setIsDragging(false);
    // if it was a click (no horizontal drag), ensure length at least 4
    setSelection(sel => {
      if (sel.length <= 1) return { ...sel, length: 4 };
      return sel;
    });
  }

  // clicking a cell without shift toggles it; with alt toggles selection placement
  function onCellClick(row, col, ev) {
    if (ev.shiftKey) {
      // place selection with top at row (clamped)
      const startRowFixed = Math.max(0, Math.min(ROWS - 4, row));
      setSelection(sel => ({ ...sel, startRow: startRowFixed, startCol: col, length: Math.max(4, sel.length) }));
      return;
    }
    toggleCell(row, col);
  }

  function randomizeGrid() {
    // schedule randomize on next beat/time: we set a timeout to happen at nextStepTimeRef
    const audioNow = audioCtxRef.current.currentTime;
    const next = Math.max(audioNow + 0.02, nextStepTimeRef.current || audioNow + 0.05);
    const ms = Math.max(0, (next - audioNow) * 1000);
    setTimeout(()=>{ const newGrid = new Uint8Array(ROWS*COLS); for (let i=0;i<newGrid.length;i++) newGrid[i] = Math.random() > 0.6 ? 1 : 0; setGrid(newGrid); }, ms);
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

  // simple UI for MIDI outputs
  const [midiOutputs, setMidiOutputs] = useState([]);
  useEffect(()=>{
    if (navigator.requestMIDIAccess) {
      navigator.requestMIDIAccess().then(m=>{ const outs = Array.from(m.outputs.values()); setMidiOutputs(outs); if (outs.length>0) engine.setMidiOutput(outs[0]); });
    }
  }, [engine]);

  // small grid renderer
  const gridRef = useRef(null);

  return (
    <div style={{ fontFamily: 'sans-serif', padding: 12 }}>
      <h2>64×64 Drum Sequencer — Demo</h2>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ width: 640, height: 640, border: '1px solid #ccc', position: 'relative' }}
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
                const inSelection = selection.active && r >= selection.startRow && r < selection.startRow + 4 && c >= selection.startCol && c < selection.startCol + selection.length;
                const isHighlightEdge = inSelection && (r === selection.startRow || r === selection.startRow + 3 || c === selection.startCol || c === selection.startCol + selection.length - 1);
                return (
                  <div key={`${r}-${c}`}
                    onClick={(ev)=>onCellClick(r,c,ev)}
                    style={{
                      width: '100%', height: '100%', boxSizing: 'border-box',
                      background: on ? '#000' : '#fff',
                      border: isHighlightEdge ? '2px solid rgba(0,120,255,0.9)' : '1px solid #ddd',
                    }} />
                );
              })
            ))}
          </div>
        </div>

        <div style={{ width: 360 }}>
          <div style={{ marginBottom: 8 }}>
            <label>BPM: <input type="number" value={bpm} onChange={e=>setBpm(Math.max(30,Math.min(300,Number(e.target.value)||120)))} style={{ width: 80 }} /></label>
            <button onClick={()=>setPlaying(p=>!p)} style={{ marginLeft: 8 }}>{playing ? 'Stop' : 'Play'}</button>
            <button onClick={randomizeGrid} style={{ marginLeft: 8 }}>Randomize (on next beat)</button>
            <div style={{ marginTop: 6 }}>Current step: {currentStep}</div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label>Mode: </label>
            <select value={mode} onChange={e=>setMode(e.target.value)}>
              <option value="sample">Sample</option>
              <option value="midi">MIDI</option>
            </select>
            {mode === 'midi' && (
              <div style={{ marginTop: 6 }}>
                <label>Channel: <input type="number" min={1} max={16} defaultValue={engine.midiChannel} onChange={e=>engine.setMidiChannel(Number(e.target.value)||1)} style={{ width: 60 }} /></label>
                <div style={{ marginTop: 6 }}>
                  MIDI Output: <select onChange={e=>{ const id=e.target.value; const out = midiOutputs.find(o=>o.id===id); if (out) engine.setMidiOutput(out); }}>
                    {midiOutputs.map(o => <option value={o.id} key={o.id}>{o.name || o.id}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: 14 }}>
            <h4>Samples / Voices</h4>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ border: '1px solid #eee', padding: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>Voice {i+1}</div>
                  <div>
                    <label>Mute <input type="checkbox" checked={mute[i]} onChange={e=>{ const m = [...mute]; m[i]=e.target.checked; setMute(m); }} /></label>
                    <label style={{ marginLeft: 8 }}>Vol <input type="range" min={0} max={1} step={0.01} value={volumes[i]} onChange={e=>{ const v = [...volumes]; v[i]=Number(e.target.value); setVolumes(v); engine.setVolume(i, Number(e.target.value)); }} /></label>
                  </div>
                </div>
                <div style={{ marginTop: 6 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="file" accept="audio/*" onChange={(e)=>handleFileInput(e,i)} />
                    <div style={{ fontSize: 12 }}>{samplesInfo[i] ? `${samplesInfo[i].name} (${samplesInfo[i].len}ms)` : 'No sample loaded'}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10, fontSize: 12 }}>
            Tips: Click cells to toggle. Click+drag horizontally to set selection length. Selection is fixed 4 rows tall. Play starts scheduling steps; samples play via WebAudio. MIDI mode will use selected MIDI output or fallback to oscillator.
          </div>
        </div>
      </div>
    </div>
  );
}

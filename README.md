# 64×64 Drum Sequencer — Demo

This folder contains a single-file React demo `64_x_64_drum_sequencer_demo.jsx` and an `index.html` wrapper that lets you run it directly in a modern browser without a build step.

Quick start

1. Open `index.html` in a modern browser. For full functionality (audio, MIDI, loading samples) you should serve the folder over HTTP instead of using the file:// protocol.

2. To serve locally (Python 3):

```bash
# from the folder that contains index.html
cd "/Users/davidleimst/Downloads/matrix drum grid"
python3 -m http.server 8000

# then open http://localhost:8000 in your browser
```

Notes
- The page uses in-browser Babel to transform JSX — this is fine for demos, but not recommended for production.
- If you experience an audio context that stays suspended, click anywhere in the page to resume audio.
- MIDI access requires granting permission in the browser and a connected MIDI device.

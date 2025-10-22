# 64×64 Drum Sequencer

A fully-featured drum sequencer with a 64×64 grid, built with React and hosted on GitHub Pages.

## Features

- **64×64 Grid**: Click cells to toggle notes on/off (black = on, white = off)
- **Flexible Selection**: Click and drag horizontally to select a sequence area (always 4 rows tall)
- **Playhead Visualization**: See the current step being played highlighted in yellow
- **Per-Row Triggering Indicators**: Visual feedback when notes are triggered
- **Seamless Grid**: No visible borders between cells for a clean appearance
- **Sample Mode**: Load your own audio samples for each of the 4 voices
- **MIDI Mode**: Output to MIDI devices
- **Real-time Controls**: Adjustable BPM, per-voice volume and mute controls
- **Randomize Function**: Generate random patterns synchronized to the beat

## Live Demo

Visit the live demo at: [https://davidfrosch.github.io/drum_matrix/](https://davidfrosch.github.io/drum_matrix/)

## Local Development

To run the sequencer locally:

1. Clone this repository:
   ```bash
   git clone https://github.com/davidfrosch/drum_matrix.git
   cd drum_matrix
   ```

2. Open `index.html` in a modern web browser:
   - You can simply double-click the file, or
   - Use a local server (recommended for full functionality):
     ```bash
     # Using Python 3
     python -m http.server 8000
     
     # Or using Node.js (if you have http-server installed)
     npx http-server
     ```
   
3. Navigate to `http://localhost:8000` in your browser

## Usage

### Basic Controls

- **Click a cell**: Toggle a note on/off
- **Click and drag horizontally**: Set the selection length
- **Shift + Click**: Move the selection to a new position
- **Play/Stop button**: Start/stop playback
- **BPM input**: Adjust the tempo (30-300 BPM)
- **Randomize button**: Generate a random pattern on the next beat

### Selection

- The selection area defines your active sequence
- It's always 4 rows tall (representing 4 voices)
- Drag horizontally to change the sequence length
- The blue border shows the selected area
- The yellow highlight shows the current playhead position

### Voices/Samples

Each of the 4 voices can:
- Load custom audio samples (Sample mode)
- Send MIDI notes (MIDI mode)
- Be muted individually
- Have adjustable volume

### Visual Feedback

- **Yellow playhead**: Shows which column is currently being played
- **Flash effect**: Cells briefly flash when notes are triggered
- **Voice highlighting**: The voice panel highlights when a note plays

## GitHub Pages Deployment

This project is configured to work with GitHub Pages:

1. The `index.html` file is in the repository root
2. All assets are loaded with relative paths or from CDN
3. Enable GitHub Pages in your repository settings:
   - Go to Settings > Pages
   - Set Source to "Deploy from a branch"
   - Select the `main` branch and `/ (root)` folder
   - Save

The site will be available at `https://[username].github.io/drum_matrix/`

## Technical Details

- **Framework**: React 18 (loaded via CDN)
- **Build Tool**: Babel Standalone (for in-browser JSX transformation)
- **Audio Engine**: Web Audio API with WebMIDI support
- **No Build Step Required**: Pure HTML/JS that runs directly in the browser

## Browser Requirements

- Modern browser with Web Audio API support (Chrome, Firefox, Safari, Edge)
- Optional: WebMIDI support for MIDI output functionality

## License

This project is open source and available for use and modification.

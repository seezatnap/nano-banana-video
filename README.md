# Nano Banana Video

<img width="2276" height="852" alt="image" src="https://github.com/user-attachments/assets/233e7325-6c55-42af-895f-f72ab0c6addf" />


A minimal Next.js app to slice a 10s clip, extract 10fps (or custom) frames, stylize them sequentially with Gemini image preview models, and export an MP4 with optional yo-yo looping, custom audio, and FPS override. All session state (frames, prompt, clip selection) is persisted in IndexedDB so refreshes keep your place.

## Setup
- Requirements: Node 18+, ffmpeg available (bundled via `ffmpeg-static` or provided on `PATH`), npm.
- Install deps: `npm install`
- Env: copy `.env.example` to `.env.local` and set:
  - `GEMINI_API_KEY` (required for transforms)
  - Optional: `GEMINI_IMAGE_MODEL` (defaults to `gemini-3-pro-image-preview`)
  - Optional: `FFMPEG_PATH` if you prefer a system binary
- Run dev server: `npm run dev` (open `http://localhost:3000`)

## Workflow
1) **Upload & clip**: select a video, scrub start, set clip length (≤10s), choose FPS (1–30), then “Generate X fps frames”.
2) **Frames view**: horizontal strip shows source frames on top and stylized slots below, keeping the video’s aspect ratio. Each frame has a popover (•••) with **Retry** (re-render) and **Clear output** (delete transformed file and reset state).
3) **Stylize**: set the style prompt (default “studio ghibli”), then Start/Stop/Resume. Frames render left→right; each frame feeds the previous stylized output into Gemini along with the next source frame.
4) **Export**: click Export MP4 to open the modal. Options:
   - Yo-yo loop count (disables original audio)
   - Custom MP3 audio (overrides original)
   - Override MP4 FPS (also disables original audio)
   - Start export to download the encoded clip.

## Persistence
- State is stored in IndexedDB locally (clip info, frames, prompt, ranges, fps). Use the **Clear session** button in the header to wipe local state and reset the UI.
- Extracted assets live under `public/runs/<clipId>/` (source frames, transformed frames, audio, export).

## API reference (overview)
- `POST /api/extract` — FormData: `video`, `start`, `duration`, `fps`. Extracts frames at fps (≤10s) plus audio.
- `POST /api/transform` — JSON: `clipId`, `frameName`, `prompt`, `previousTransformedName`. Sends previous stylized frame + current source to Gemini; writes transformed PNG.
- `POST /api/export` — FormData: `clipId`, `fps`, `yoyoCount?`, `overrideFps?`, optional `audio` file. Encodes MP4 from frames (falling back to source when transformed missing) and optional audio.

## Tips
- If exports show black video, ensure ffmpeg can read `public/runs/<clipId>/export_work/frame_*.png` and that transformed frames exist; the encoder falls back to source frames automatically.
- Gemini overloads return a clear “Gemini is under load” message; retry later.
- For accurate aspect ratios on captures, keep the upload video accessible during the session; a stored `inputUrl` is used when available.

## Scripts
- `npm run dev` — start dev server
- `npm run lint` — lint with ESLint

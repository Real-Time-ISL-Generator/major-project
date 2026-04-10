# ISL Web App

React + Vite frontend for subtitle-driven sign skeleton playback.

This app can:
- Accept a YouTube URL and ask the local backend to download English subtitles.
- Accept a local subtitle file (`.srt` or `.vtt`).
- Parse subtitle chunks and render each chunk through the hosted pose endpoint.
- Display the result in the `pose-viewer` custom element while syncing with YouTube playback.

## Architecture

This project is part of a two-service setup:
- Frontend: `isl-web-app` (this folder)
- Backend: `../backend` (FastAPI + `yt-dlp`)

High-level flow:
1. Frontend submits YouTube URL to backend `GET /download`.
2. Backend downloads subtitle file and returns `video_id` + `subtitle_url`.
3. Frontend fetches subtitle text from `subtitle_url`.
4. Frontend parses subtitle chunks and advances through them in sequence.
5. Each chunk text is sent to hosted `spoken_text_to_signed_pose` via URL params.
6. `pose-viewer` renders the returned skeleton animation.

## Key Files

- `src/App.tsx`: queue/sync orchestration, YouTube API integration, pose URL updates.
- `src/components/TextInputPanel.tsx`: YouTube submit + local subtitle file upload.
- `src/components/SkeletonViewerPanel.tsx`: `pose-viewer` loading/render/error behavior.
- `src/lib/subtitleParser.ts`: SRT parsing into timed chunks.
- `src/lib/translation.ts`: hosted translation endpoint URL builder.
- `src/test/setupTests.ts`: Vitest setup and custom element mocks.

## Local Development

Prerequisites:
- Node.js 20+
- Python 3.10+

1. Install frontend dependencies:

```bash
cd /mnt/sd1/ameer/Project/isl-web-app
npm install
```

2. Install backend dependencies:

```bash
cd /mnt/sd1/ameer/Project/backend
pip install fastapi uvicorn yt-dlp
```

3. Start backend:

```bash
cd /mnt/sd1/ameer/Project/backend
uvicorn server:app --reload --host 127.0.0.1 --port 8000
```

4. Start frontend:

```bash
cd /mnt/sd1/ameer/Project/isl-web-app
npm run dev
```

5. Open Vite URL (usually `http://localhost:5173`).

## Scripts

- `npm run dev`: start frontend dev server
- `npm run build`: type-check + production build
- `npm run preview`: preview built app
- `npm run test`: run Vitest once
- `npm run test:watch`: run Vitest in watch mode

## Notes and Limitations

- Translation inference is hosted remotely; model is not bundled locally.
- Current backend subtitle language is fixed to English (`en`).
- App expects backend at `http://127.0.0.1:8000`.


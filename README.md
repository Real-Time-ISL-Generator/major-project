# Major-Project

This repository is intended to be the single root repo for the whole project.

It contains:

- `backend/`: FastAPI service that downloads English YouTube subtitles with `yt-dlp`
- `isl-web-app/`: React + Vite frontend that parses subtitle chunks and renders signing poses with `pose-viewer`

## Important Portability Note

Do not rely on checked-in environment artifacts such as:

- `venv/`
- `.venv/`
- `isl-web-app/node_modules/`
- `isl-web-app/dist/`

Those folders are machine-specific and should be recreated locally on each system.

## Prerequisites

- Python 3.10 or newer
- Node.js 20 or newer
- npm 10 or newer

Check your versions:

```bash
python3 --version
node --version
npm --version
```

Windows PowerShell:

```powershell
py --version
node --version
npm --version
```

## Recommended Cleanup On A New Machine

Only do this if the repo already contains copied dependencies or build output.

macOS / Linux:

```bash
rm -rf venv .venv isl-web-app/node_modules isl-web-app/dist backend/__pycache__
```

Windows PowerShell:

```powershell
Remove-Item -Recurse -Force venv, .venv, isl-web-app\node_modules, isl-web-app\dist, backend\__pycache__
```

## Backend Setup

The backend dependencies are listed in [backend/requirements.txt](/Users/farzaan/Desktop/Project/backend/requirements.txt).

### macOS / Linux

```bash
cd /path/to/Project
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
```

### Windows PowerShell

```powershell
cd C:\path\to\Project
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

Start the backend:

```bash
cd /path/to/Project/backend
uvicorn server:app --reload --host 127.0.0.1 --port 8000
```

Windows PowerShell:

```powershell
cd C:\path\to\Project\backend
uvicorn server:app --reload --host 127.0.0.1 --port 8000
```

Useful backend URLs:

- Health check: [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)
- API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

## Frontend Setup

Install frontend dependencies:

```bash
cd /path/to/Project/isl-web-app
npm install
```

If you want the frontend to use a different backend host, create `isl-web-app/.env.local`:

```bash
VITE_BACKEND_BASE_URL=http://127.0.0.1:8000
```

You can copy from [isl-web-app/.env.example](/Users/farzaan/Desktop/Project/isl-web-app/.env.example).

Start the frontend:

```bash
cd /path/to/Project/isl-web-app
npm run dev
```

Then open the Vite URL shown in the terminal, usually [http://localhost:5173](http://localhost:5173).

## Local Run Order

Open two terminals:

1. Start the backend from `backend/`
2. Start the frontend from `isl-web-app/`

Then test one of these flows:

- Type plain text and click `Submit`
- Upload an `.srt` or `.vtt` file
- Paste a YouTube URL with English subtitles available

## Troubleshooting

### `npm install` or `npm run dev` fails with Rollup or optional dependency errors

This usually means `node_modules` was copied from another machine or architecture. Delete `isl-web-app/node_modules` and reinstall on the current machine.

### The Python virtual environment does not run

That is expected when a virtual environment was created on another OS. Create a fresh `.venv` locally and reinstall from `backend/requirements.txt`.

### YouTube requests fail with `CERTIFICATE_VERIFY_FAILED`

Reinstall backend dependencies so `certifi` is present:

```bash
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
```

Then restart the backend. The backend is configured to use the `certifi` CA bundle automatically.

### The frontend cannot reach the backend

Check:

- the backend is running on `127.0.0.1:8000`
- `VITE_BACKEND_BASE_URL` is correct if you changed it
- [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health) returns `{"status":"ok"}`

### YouTube subtitles are not found

The backend currently requests English subtitles only. Some videos do not provide English subtitles or auto-generated captions in a format `yt-dlp` can fetch.

## Project Structure

- [backend/server.py](/Users/farzaan/Desktop/Project/backend/server.py): backend entrypoint
- [backend/requirements.txt](/Users/farzaan/Desktop/Project/backend/requirements.txt): backend dependency manifest
- [isl-web-app/src/App.tsx](/Users/farzaan/Desktop/Project/isl-web-app/src/App.tsx): main frontend orchestration
- [isl-web-app/src/lib/backend.ts](/Users/farzaan/Desktop/Project/isl-web-app/src/lib/backend.ts): backend URL configuration helper
- [isl-web-app/src/lib/subtitleParser.ts](/Users/farzaan/Desktop/Project/isl-web-app/src/lib/subtitleParser.ts): subtitle parsing
- [isl-web-app/src/lib/translation.ts](/Users/farzaan/Desktop/Project/isl-web-app/src/lib/translation.ts): hosted pose URL builder

## Current Local Status

- The nested `isl-web-app/.git` repo has been removed.
- The root `/Users/farzaan/Desktop/Project` folder is now initialized as a Git repo on `main`.
- A GitHub remote has not been added yet because the GitHub owner/URL has not been provided and `gh` is not installed in this environment.

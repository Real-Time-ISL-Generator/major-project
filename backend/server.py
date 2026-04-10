import os
from pathlib import Path

import certifi
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import uuid
from urllib.parse import urlparse, parse_qs

import yt_dlp

os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BACKEND_DIR = Path(__file__).resolve().parent
DOWNLOAD_PATH = BACKEND_DIR / "downloads"
DOWNLOAD_PATH.mkdir(parents=True, exist_ok=True)
app.mount("/downloads", StaticFiles(directory=str(DOWNLOAD_PATH)), name="downloads")


def get_video_id(url: str) -> str | None:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    path_parts = [part for part in parsed.path.split("/") if part]

    if hostname in {"youtu.be", "www.youtu.be"}:
        return path_parts[0] if path_parts else None

    if hostname.endswith("youtube.com"):
        query_video_id = parse_qs(parsed.query).get("v", [None])[0]
        if query_video_id:
            return query_video_id

        if len(path_parts) >= 2 and path_parts[0] in {"shorts", "embed", "live", "v"}:
            return path_parts[1]

    return None


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/download")
def download_subtitle(url: str = Query(..., min_length=1)):
    try:
        unique_id = str(uuid.uuid4())

        ydl_opts = {
            "outtmpl": str(DOWNLOAD_PATH / f"{unique_id}.%(ext)s"),
            "skip_download": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": ["en"],
            "subtitlesformat": "srt",
            "quiet": True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

            if isinstance(info, dict) and info.get("entries"):
                info = next((entry for entry in info["entries"] if entry), info)

            video_id = info.get("id") if isinstance(info, dict) else None
            if not video_id:
                video_id = get_video_id(url)

            if not video_id:
                raise HTTPException(
                    status_code=400,
                    detail="Could not determine the YouTube video ID from this URL.",
                )

            ydl.download([url])

        subtitle_file = next(DOWNLOAD_PATH.glob(f"{unique_id}*.srt"), None)
        if subtitle_file is None:
            raise HTTPException(
                status_code=404,
                detail="No English subtitle file was generated for this video.",
            )

        subtitle_url = f"/downloads/{subtitle_file.name}"

        return {
            "video_id": video_id,
            "subtitle": str(subtitle_file),
            "subtitle_url": subtitle_url,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

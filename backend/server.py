import logging
import os
from pathlib import Path
import sys

import certifi
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import uuid
from urllib.parse import urlparse, parse_qs

import yt_dlp

os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

logger = logging.getLogger(__name__)

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

MACOS_DEFAULT_COOKIE_BROWSERS = ("safari", "chrome", "brave", "chromium", "edge", "firefox")
DEFAULT_COOKIE_BROWSERS = ("chrome", "edge", "brave", "chromium", "firefox")


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


def get_default_cookie_browsers() -> tuple[str, ...]:
    return MACOS_DEFAULT_COOKIE_BROWSERS if sys.platform == "darwin" else DEFAULT_COOKIE_BROWSERS


def should_retry_with_cookies(error: Exception) -> bool:
    message = str(error).lower()
    return any(
        marker in message
        for marker in (
            "sign in to confirm you’re not a bot",
            "sign in to confirm you're not a bot",
            "--cookies-from-browser",
            "use --cookies",
        )
    )


def is_skippable_cookie_source_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(
        marker in message
        for marker in (
            "cookies database",
            "cookie database",
            "browser profile",
            "profile not found",
            "could not find",
            "browser not installed",
        )
    )


def unique_preserving_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []

    for value in values:
        if value and value not in seen:
            seen.add(value)
            ordered.append(value)

    return ordered


def get_auth_retry_candidates() -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []

    cookie_file = os.getenv("YTDLP_COOKIE_FILE", "").strip()
    if cookie_file:
        candidates.append(("cookiefile", cookie_file))

    browsers: list[str] = []

    configured_browser = os.getenv("YTDLP_COOKIE_BROWSER", "").strip().lower()
    if configured_browser:
        browsers.append(configured_browser)

    configured_browsers = os.getenv("YTDLP_COOKIE_BROWSERS", "").strip()
    if configured_browsers:
        browsers.extend(browser.strip().lower() for browser in configured_browsers.split(","))

    browsers.extend(get_default_cookie_browsers())

    for browser in unique_preserving_order(browsers):
        candidates.append(("browser", browser))

    return candidates


def build_ydl_opts(unique_id: str, *, cookie_browser: str | None = None, cookie_file: str | None = None) -> dict:
    ydl_opts = {
        "outtmpl": str(DOWNLOAD_PATH / f"{unique_id}.%(ext)s"),
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en"],
        "subtitlesformat": "srt",
        "quiet": True,
    }

    if cookie_file:
        ydl_opts["cookiefile"] = cookie_file

    if cookie_browser:
        profile = os.getenv("YTDLP_COOKIE_PROFILE", "").strip() or None
        ydl_opts["cookiesfrombrowser"] = (cookie_browser, profile) if profile else (cookie_browser,)

    return ydl_opts


def resolve_video_id(info: object, url: str) -> str:
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

    return video_id


def run_download_attempt(url: str, unique_id: str, *, cookie_browser: str | None = None, cookie_file: str | None = None) -> str:
    ydl_opts = build_ydl_opts(unique_id, cookie_browser=cookie_browser, cookie_file=cookie_file)

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        video_id = resolve_video_id(info, url)
        ydl.download([url])
        return video_id


def download_with_yt_dlp(url: str, unique_id: str) -> str:
    logger.info("YouTube subtitle download attempt started without cookies")

    try:
        video_id = run_download_attempt(url, unique_id)
        logger.info("YouTube subtitle download succeeded without cookies")
        return video_id
    except HTTPException:
        raise
    except Exception as error:
        if not should_retry_with_cookies(error):
            logger.exception("YouTube subtitle download failed without bot-check retry")
            raise

        logger.warning("YouTube requested authentication; retrying with cookie-backed auth")
        meaningful_error: Exception = error

        for candidate_type, candidate_value in get_auth_retry_candidates():
            try:
                if candidate_type == "cookiefile":
                    logger.info("Retrying YouTube subtitle download with cookie file")
                    video_id = run_download_attempt(url, unique_id, cookie_file=candidate_value)
                    logger.info("YouTube subtitle download succeeded with cookie file")
                    return video_id

                logger.info("Retrying YouTube subtitle download with browser cookies: %s", candidate_value)
                video_id = run_download_attempt(url, unique_id, cookie_browser=candidate_value)
                logger.info("YouTube subtitle download succeeded with browser cookies: %s", candidate_value)
                return video_id
            except HTTPException:
                raise
            except Exception as candidate_error:
                if candidate_type == "browser" and is_skippable_cookie_source_error(candidate_error):
                    logger.info(
                        "Skipping browser cookie candidate %s: %s",
                        candidate_value,
                        candidate_error,
                    )
                    continue

                meaningful_error = candidate_error
                logger.warning(
                    "Cookie-backed YouTube retry failed via %s %s: %s",
                    candidate_type,
                    candidate_value,
                    candidate_error,
                )

        logger.error("All YouTube auth retry attempts failed: %s", meaningful_error)
        raise meaningful_error


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/download")
def download_subtitle(url: str = Query(..., min_length=1)):
    try:
        unique_id = str(uuid.uuid4())
        video_id = download_with_yt_dlp(url, unique_id)

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

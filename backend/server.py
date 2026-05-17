import logging
import os
from pathlib import Path
import re
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import certifi
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi.staticfiles import StaticFiles
import uuid
from urllib.parse import urlparse, parse_qs
import json

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
GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.1-8b-instant"
GROQ_PROMPT_LIMIT = 800
GROQ_ANSWER_WORD_LIMIT = 12


class GroqPromptRequest(BaseModel):
    prompt: str


def load_local_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")

        if key and key not in os.environ:
            os.environ[key] = value


load_local_env_file(BACKEND_DIR / ".env")


class SpeechSessionState:
    def __init__(self) -> None:
        self.session_id = str(uuid.uuid4())
        self.sequence_id = 0
        self.started = False

    def next_sequence_id(self) -> int:
        self.sequence_id += 1
        return self.sequence_id


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


def normalize_groq_answer(answer: str) -> str:
    normalized = re.sub(r"\s+", " ", answer).strip()
    normalized = re.sub(r"^(?:[-*•]|\d+[.)])\s+", "", normalized)
    normalized = normalized.strip(" \t\r\n\"'`*_")

    words = normalized.split()
    if len(words) > GROQ_ANSWER_WORD_LIMIT:
        normalized = " ".join(words[:GROQ_ANSWER_WORD_LIMIT]).rstrip(".,;:!?")

    return normalized


def extract_groq_answer(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""

    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return ""

    message = first_choice.get("message")
    if not isinstance(message, dict):
        return ""

    content = message.get("content")
    return content if isinstance(content, str) else ""


def read_groq_error_body(error: HTTPError) -> str:
    try:
        return error.read().decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def build_groq_http_error_detail(status_code: int) -> str:
    if status_code in {401, 403}:
        return "Groq rejected the API key or project permissions. Check the key in backend/.env."
    if status_code == 429:
        return "Groq rate limit reached. Please wait and try again."
    return "Groq could not generate an answer right now."


def call_groq_concise_answer(prompt: str) -> str:
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Groq API key is not configured. Set GROQ_API_KEY on the backend.",
        )

    payload = {
        "model": GROQ_MODEL,
        "temperature": 0.2,
        "max_completion_tokens": 40,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Answer in one concise, signable English sentence. "
                    "Use at most 12 words. Do not use markdown."
                ),
            },
            {"role": "user", "content": prompt},
        ],
    }

    request = Request(
        GROQ_CHAT_COMPLETIONS_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "ISL-Translation-Studio/1.0",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=20) as response:
            response_payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        error_body = read_groq_error_body(error)
        logger.warning("Groq request failed with HTTP status %s: %s", error.code, error_body)
        raise HTTPException(status_code=502, detail=build_groq_http_error_detail(error.code)) from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        logger.warning("Groq request failed: %s", error)
        raise HTTPException(status_code=502, detail="Groq could not generate an answer right now.") from error

    answer = normalize_groq_answer(extract_groq_answer(response_payload))
    if not answer:
        raise HTTPException(status_code=502, detail="Groq returned an empty answer.")

    return answer


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/groq/concise-answer")
def groq_concise_answer(request: GroqPromptRequest):
    prompt = re.sub(r"\s+", " ", request.prompt).strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt text is required.")

    if len(prompt) > GROQ_PROMPT_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=f"Prompt is too long. Keep it under {GROQ_PROMPT_LIMIT} characters.",
        )

    return {"answer": call_groq_concise_answer(prompt)}


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


def build_transcript_event(
    session: SpeechSessionState,
    transcript_type: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    event_type = "transcript_final" if transcript_type == "final" else "transcript_interim"
    text = str(payload.get("text", "")).strip()
    confidence = payload.get("confidence")
    created_at_ms = int(payload.get("created_at_ms") or 0)
    speech_start_ms = payload.get("speech_start_ms")
    speech_end_ms = payload.get("speech_end_ms")

    return {
        "type": event_type,
        "session_id": session.session_id,
        "sequence_id": session.next_sequence_id(),
        "text": text,
        "confidence": confidence if isinstance(confidence, (float, int)) else None,
        "created_at_ms": created_at_ms,
        "speech_start_ms": speech_start_ms if isinstance(speech_start_ms, (float, int)) else None,
        "speech_end_ms": speech_end_ms if isinstance(speech_end_ms, (float, int)) else None,
    }


async def send_socket_error(websocket: WebSocket, detail: str) -> None:
    await websocket.send_json({"type": "error", "detail": detail})


@app.websocket("/speech/stream")
async def speech_stream(websocket: WebSocket):
    await websocket.accept()
    session = SpeechSessionState()

    try:
        while True:
            payload = await websocket.receive_json()
            message_type = str(payload.get("type", "")).strip()

            if message_type == "start_session":
                session.started = True
                await websocket.send_json(
                    {
                        "type": "session_started",
                        "session_id": session.session_id,
                        "mode": "browser_fallback",
                        "requires_client_transcripts": True,
                    }
                )
                continue

            if not session.started:
                await send_socket_error(websocket, "Send start_session before streaming audio or transcript events.")
                continue

            if message_type == "audio_chunk":
                await websocket.send_json({"type": "vad_state", "state": "listening"})
                continue

            if message_type == "vad_state":
                state = str(payload.get("state", "listening")).strip().lower()
                if state not in {"listening", "speaking", "processing"}:
                    await send_socket_error(websocket, "Unsupported vad_state value.")
                    continue

                await websocket.send_json({"type": "vad_state", "state": state})
                continue

            if message_type == "client_transcript":
                transcript_type = str(payload.get("transcript_state", "interim")).strip().lower()
                if transcript_type not in {"interim", "final"}:
                    await send_socket_error(websocket, "Unsupported transcript_state value.")
                    continue

                if not str(payload.get("text", "")).strip():
                    await send_socket_error(websocket, "Transcript text is required.")
                    continue

                await websocket.send_json(build_transcript_event(session, transcript_type, payload))

                if transcript_type == "final":
                    await websocket.send_json({"type": "vad_state", "state": "processing"})
                continue

            if message_type == "end_session":
                await websocket.send_json({"type": "session_ended", "session_id": session.session_id})
                break

            await send_socket_error(websocket, f"Unsupported speech session message type: {message_type}")
    except WebSocketDisconnect:
        logger.info("Speech websocket disconnected: %s", session.session_id)

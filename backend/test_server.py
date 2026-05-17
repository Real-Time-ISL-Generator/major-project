import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from io import BytesIO

from fastapi import HTTPException
from fastapi.testclient import TestClient

import server


class FakeYoutubeDL:
    def __init__(self, opts, behavior):
        self.opts = opts
        self.behavior = behavior
        self.extract_info_calls = []
        self.download_calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def extract_info(self, url, download=False):
        self.extract_info_calls.append((url, download))
        result = self.behavior["extract_info"]
        if isinstance(result, Exception):
            raise result
        return result

    def download(self, urls):
        self.download_calls.append(urls)
        action = self.behavior.get("download")
        if callable(action):
            action(self.opts)
        elif isinstance(action, Exception):
            raise action


class FakeGroqResponse:
    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return self.payload


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.download_path = Path(self.tempdir.name)
        self.env_patch = patch.dict(os.environ, {}, clear=False)
        self.env_patch.start()
        self.download_path_patch = patch.object(server, "DOWNLOAD_PATH", self.download_path)
        self.download_path_patch.start()

    def tearDown(self):
        self.download_path_patch.stop()
        self.env_patch.stop()
        self.tempdir.cleanup()

    def make_ydl_factory(self, behaviors):
        created = []

        def factory(opts):
            behavior = behaviors[len(created)]
            ydl = FakeYoutubeDL(opts, behavior)
            created.append(ydl)
            return ydl

        return factory, created

    def test_plain_success_returns_existing_payload_shape(self):
        unique_id = "test-success"

        def create_subtitle(_opts):
            (self.download_path / f"{unique_id}.en.srt").write_text("hello", encoding="utf-8")

        factory, created = self.make_ydl_factory(
            [{"extract_info": {"id": "abc123"}, "download": create_subtitle}]
        )

        with patch("server.uuid.uuid4", return_value=unique_id), patch("server.yt_dlp.YoutubeDL", side_effect=factory):
            response = server.download_subtitle("https://www.youtube.com/watch?v=abc123")

        self.assertEqual(response["video_id"], "abc123")
        self.assertEqual(response["subtitle_url"], f"/downloads/{unique_id}.en.srt")
        self.assertTrue(response["subtitle"].endswith(f"{unique_id}.en.srt"))
        self.assertEqual(len(created), 1)
        self.assertNotIn("cookiesfrombrowser", created[0].opts)

    def test_playlist_like_entries_info_resolves_video_id(self):
        factory, _created = self.make_ydl_factory(
            [{"extract_info": {"entries": [None, {"id": "entry123"}]}, "download": lambda _opts: None}]
        )

        with patch("server.yt_dlp.YoutubeDL", side_effect=factory):
            video_id = server.run_download_attempt("https://www.youtube.com/watch?v=entry123", "playlist-case")

        self.assertEqual(video_id, "entry123")

    def test_bot_check_on_first_attempt_triggers_cookie_retry(self):
        os.environ["YTDLP_COOKIE_BROWSER"] = "safari"
        bot_error = Exception("Sign in to confirm you’re not a bot. Use --cookies-from-browser")
        factory, created = self.make_ydl_factory(
            [
                {"extract_info": bot_error},
                {"extract_info": {"id": "abc123"}, "download": lambda _opts: None},
            ]
        )

        with patch("server.yt_dlp.YoutubeDL", side_effect=factory):
            video_id = server.download_with_yt_dlp("https://www.youtube.com/watch?v=abc123", "retry-case")

        self.assertEqual(video_id, "abc123")
        self.assertEqual(len(created), 2)
        self.assertEqual(created[1].opts["cookiesfrombrowser"], ("safari",))

    def test_cookie_file_is_tried_before_browser_candidates(self):
        os.environ["YTDLP_COOKIE_FILE"] = "/tmp/cookies.txt"
        os.environ["YTDLP_COOKIE_BROWSER"] = "safari"
        candidates = server.get_auth_retry_candidates()

        self.assertEqual(candidates[0], ("cookiefile", "/tmp/cookies.txt"))
        self.assertEqual(candidates[1], ("browser", "safari"))

    def test_cookie_browser_overrides_default_order(self):
        os.environ["YTDLP_COOKIE_BROWSER"] = "firefox"
        candidates = server.get_auth_retry_candidates()

        self.assertEqual(candidates[0], ("browser", "firefox"))
        self.assertIn(("browser", "safari"), candidates if server.sys.platform == "darwin" else candidates)

    def test_missing_browser_database_is_skipped_and_next_candidate_is_tried(self):
        bot_error = Exception("Sign in to confirm you’re not a bot. Use --cookies-from-browser")
        missing_browser_error = Exception("could not find firefox cookies database")
        factory, created = self.make_ydl_factory(
            [
                {"extract_info": bot_error},
                {"extract_info": missing_browser_error},
                {"extract_info": {"id": "abc123"}, "download": lambda _opts: None},
            ]
        )

        with patch("server.get_auth_retry_candidates", return_value=[("browser", "firefox"), ("browser", "safari")]), patch(
            "server.yt_dlp.YoutubeDL", side_effect=factory
        ):
            video_id = server.download_with_yt_dlp("https://www.youtube.com/watch?v=abc123", "skip-case")

        self.assertEqual(video_id, "abc123")
        self.assertEqual(len(created), 3)
        self.assertEqual(created[1].opts["cookiesfrombrowser"], ("firefox",))
        self.assertEqual(created[2].opts["cookiesfrombrowser"], ("safari",))

    def test_no_subtitle_file_still_returns_404(self):
        unique_id = "missing-subtitle"
        factory, _created = self.make_ydl_factory(
            [{"extract_info": {"id": "abc123"}, "download": lambda _opts: None}]
        )

        with patch("server.uuid.uuid4", return_value=unique_id), patch("server.yt_dlp.YoutubeDL", side_effect=factory):
            with self.assertRaises(HTTPException) as context:
                server.download_subtitle("https://www.youtube.com/watch?v=abc123")

        self.assertEqual(context.exception.status_code, 404)

    def test_unknown_failure_does_not_trigger_cookie_retries(self):
        factory, created = self.make_ydl_factory(
            [{"extract_info": Exception("network exploded")}]
        )

        with patch("server.yt_dlp.YoutubeDL", side_effect=factory):
            with self.assertRaises(Exception) as context:
                server.download_with_yt_dlp("https://www.youtube.com/watch?v=abc123", "plain-fail")

        self.assertEqual(str(context.exception), "network exploded")
        self.assertEqual(len(created), 1)

    def test_groq_endpoint_requires_api_key(self):
        client = TestClient(server.app)

        with patch.dict(os.environ, {"GROQ_API_KEY": ""}):
            response = client.post("/groq/concise-answer", json={"prompt": "What is ISL?"})

        self.assertEqual(response.status_code, 503)
        self.assertIn("GROQ_API_KEY", response.json()["detail"])

    def test_local_env_file_sets_missing_values_without_overwriting(self):
        env_file = self.download_path / ".env"
        env_file.write_text(
            "GROQ_API_KEY=file-key\nEXISTING_VALUE=file-value\n",
            encoding="utf-8",
        )

        with patch.dict(os.environ, {"EXISTING_VALUE": "shell-value"}, clear=True):
            server.load_local_env_file(env_file)

            self.assertEqual(os.environ["GROQ_API_KEY"], "file-key")
            self.assertEqual(os.environ["EXISTING_VALUE"], "shell-value")

    def test_groq_endpoint_rejects_empty_prompt(self):
        client = TestClient(server.app)

        response = client.post("/groq/concise-answer", json={"prompt": "   "})

        self.assertEqual(response.status_code, 400)
        self.assertIn("required", response.json()["detail"])

    def test_groq_endpoint_returns_normalized_short_answer(self):
        client = TestClient(server.app)
        groq_payload = (
            b'{"choices":[{"message":{"content":"- Indian Sign Language helps people communicate clearly with visual gestures every day."}}]}'
        )

        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key"}), patch(
            "server.urlopen",
            return_value=FakeGroqResponse(groq_payload),
        ) as urlopen_mock:
            response = client.post("/groq/concise-answer", json={"prompt": "What is ISL?"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"answer": "Indian Sign Language helps people communicate clearly with visual gestures every day."},
        )
        request = urlopen_mock.call_args.args[0]
        self.assertEqual(request.headers["Authorization"], "Bearer test-key")
        self.assertEqual(request.headers["User-agent"], "ISL-Translation-Studio/1.0")

    def test_groq_endpoint_returns_safe_error_on_failure(self):
        client = TestClient(server.app)

        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key"}), patch(
            "server.urlopen",
            side_effect=URLError("network exploded"),
        ):
            response = client.post("/groq/concise-answer", json={"prompt": "What is ISL?"})

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Groq could not generate an answer right now.")

    def test_groq_endpoint_returns_key_guidance_on_forbidden(self):
        client = TestClient(server.app)
        forbidden_error = HTTPError(
            url=server.GROQ_CHAT_COMPLETIONS_URL,
            code=403,
            msg="Forbidden",
            hdrs={},
            fp=BytesIO(b'{"error":{"message":"Forbidden"}}'),
        )

        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key"}), patch(
            "server.urlopen",
            side_effect=forbidden_error,
        ):
            response = client.post("/groq/concise-answer", json={"prompt": "What is ISL?"})

        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            response.json()["detail"],
            "Groq rejected the API key or project permissions. Check the key in backend/.env.",
        )

    def test_speech_socket_session_lifecycle(self):
        client = TestClient(server.app)

        with client.websocket_connect("/speech/stream") as websocket:
            websocket.send_json({"type": "start_session", "preferred_mode": "browser_fallback"})
            started = websocket.receive_json()

            self.assertEqual(started["type"], "session_started")
            self.assertEqual(started["mode"], "browser_fallback")
            self.assertTrue(started["requires_client_transcripts"])

            websocket.send_json({"type": "end_session"})
            ended = websocket.receive_json()

            self.assertEqual(ended["type"], "session_ended")
            self.assertEqual(ended["session_id"], started["session_id"])

    def test_speech_socket_normalizes_transcript_events_in_order(self):
        client = TestClient(server.app)

        with client.websocket_connect("/speech/stream") as websocket:
            websocket.send_json({"type": "start_session"})
            started = websocket.receive_json()

            websocket.send_json(
                {
                    "type": "client_transcript",
                    "transcript_state": "interim",
                    "text": "hello there",
                    "created_at_ms": 101,
                    "speech_start_ms": 11,
                }
            )
            interim = websocket.receive_json()

            websocket.send_json(
                {
                    "type": "client_transcript",
                    "transcript_state": "final",
                    "text": "hello there friend",
                    "confidence": 0.91,
                    "created_at_ms": 202,
                    "speech_start_ms": 11,
                    "speech_end_ms": 99,
                }
            )
            final_event = websocket.receive_json()
            processing = websocket.receive_json()

            self.assertEqual(interim["type"], "transcript_interim")
            self.assertEqual(final_event["type"], "transcript_final")
            self.assertEqual(interim["session_id"], started["session_id"])
            self.assertEqual(final_event["session_id"], started["session_id"])
            self.assertLess(interim["sequence_id"], final_event["sequence_id"])
            self.assertEqual(final_event["confidence"], 0.91)
            self.assertEqual(final_event["speech_end_ms"], 99)
            self.assertEqual(processing, {"type": "vad_state", "state": "processing"})

    def test_speech_socket_rejects_transcript_before_session_start(self):
        client = TestClient(server.app)

        with client.websocket_connect("/speech/stream") as websocket:
            websocket.send_json(
                {
                    "type": "client_transcript",
                    "transcript_state": "final",
                    "text": "too early",
                }
            )
            error_event = websocket.receive_json()

            self.assertEqual(error_event["type"], "error")
            self.assertIn("start_session", error_event["detail"])


if __name__ == "__main__":
    unittest.main()

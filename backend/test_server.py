import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException

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


if __name__ == "__main__":
    unittest.main()

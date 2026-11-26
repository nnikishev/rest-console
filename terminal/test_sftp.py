import base64
import hashlib
import io
import stat
import zipfile
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock

from .sftp import LIMIT, PREVIEW_LIMIT, directory_archive, operate


class SftpTests(TestCase):
    def setUp(self):
        self.client = MagicMock()
        self.sftp = self.client.open_sftp.return_value.__enter__.return_value

    def test_preview_is_bounded_and_not_html(self):
        self.sftp.stat.return_value.st_mode = stat.S_IFREG
        remote = self.sftp.open.return_value.__enter__.return_value
        remote.read.return_value = b"<script>alert(1)</script>" + b"a" * PREVIEW_LIMIT
        result = operate(self.client, {"action": "preview", "path": "/tmp/a.html"})
        self.assertTrue(result["truncated"])
        self.assertEqual(len(base64.b64decode(result["content"])), PREVIEW_LIMIT)
        remote.read.assert_called_once_with(PREVIEW_LIMIT + 1)

    def test_archive_nested_directory_skips_symlinks(self):
        folder = SimpleNamespace(filename="sub", st_mode=stat.S_IFDIR, st_size=0)
        file = SimpleNamespace(filename="a.txt", st_mode=stat.S_IFREG, st_size=2)
        link = SimpleNamespace(filename="link", st_mode=stat.S_IFLNK, st_size=0)
        self.sftp.listdir_iter.side_effect = lambda path: iter(
            [folder, link] if path == "/root" else [file]
        )
        self.sftp.open.return_value.__enter__.return_value.read.return_value = b"hi"
        result = directory_archive(self.sftp, "/root")
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["content"]))) as archive:
            self.assertEqual(archive.read("root/sub/a.txt"), b"hi")
            self.assertNotIn("root/link", archive.namelist())
        self.assertEqual(result["name"], "root.zip")

    def test_archive_limits_and_unsafe_names(self):
        for name, size in (("../bad", 0), ("large", LIMIT + 1)):
            self.sftp.listdir_iter.return_value = [
                SimpleNamespace(filename=name, st_mode=stat.S_IFREG, st_size=size)
            ]
            with self.assertRaises(ValueError):
                directory_archive(self.sftp, "/root")

    def test_save_checks_revision_before_writing(self):
        self.sftp.stat.return_value.st_mode = stat.S_IFREG
        remote = self.sftp.open.return_value.__enter__.return_value
        remote.read.return_value = b"old"
        revision = hashlib.sha256(b"old").hexdigest()
        result = operate(
            self.client, {"action": "save", "path": "/tmp/a", "text": "new", "revision": revision}
        )
        self.assertEqual(result["revision"], hashlib.sha256(b"new").hexdigest())
        remote.write.assert_called_once_with(b"new")
        remote.truncate.assert_called_once_with(3)
        remote.write.reset_mock()
        with self.assertRaisesRegex(ValueError, "изменился"):
            operate(
                self.client,
                {"action": "save", "path": "/tmp/a", "text": "oops", "revision": "stale"},
            )
        remote.write.assert_not_called()

    def test_save_rejects_oversized_and_binary_content(self):
        for text in ("a" * (PREVIEW_LIMIT + 1), "a\0b"):
            with self.assertRaises(ValueError):
                operate(
                    self.client, {"action": "save", "path": "/tmp/a", "text": text, "revision": "x"}
                )
        self.sftp.open.assert_not_called()

    def test_list_normalizes_and_sorts(self):
        self.sftp.normalize.return_value = "/home/deploy"
        self.sftp.listdir_iter.return_value = [
            SimpleNamespace(filename="z.txt", st_mode=stat.S_IFREG, st_size=4),
            SimpleNamespace(filename="folder", st_mode=stat.S_IFDIR, st_size=0),
        ]
        result = operate(self.client, {"action": "list", "path": "."})
        self.assertEqual(result["path"], "/home/deploy")
        self.assertEqual(result["entries"][0]["name"], "folder")

    def test_upload_uses_exclusive_creation(self):
        result = operate(
            self.client,
            {
                "action": "upload",
                "path": "/tmp/new.txt",
                "content": base64.b64encode(b"hello").decode(),
            },
        )
        self.assertTrue(result["uploaded"])
        self.sftp.open.assert_called_once_with("/tmp/new.txt", "wx")
        self.sftp.open.return_value.__enter__.return_value.write.assert_called_once_with(b"hello")

    def test_download_is_bounded(self):
        remote = self.sftp.open.return_value.__enter__.return_value
        remote.stat.return_value.st_size = 2
        remote.read.return_value = b"hi"
        result = operate(self.client, {"action": "download", "path": "/tmp/a"})
        self.assertEqual(base64.b64decode(result["content"]), b"hi")
        remote.read.assert_called_once_with(LIMIT + 1)
        remote.stat.return_value.st_size = LIMIT + 1
        with self.assertRaises(ValueError):
            operate(self.client, {"action": "download", "path": "/tmp/a"})

    def test_invalid_paths_and_payloads(self):
        for path in ("", "a\0b", 123):
            with self.assertRaises(ValueError):
                operate(self.client, {"action": "list", "path": path})
        with self.assertRaises(ValueError):
            operate(self.client, {"action": "upload", "path": "/tmp/a", "content": "!!!"})

    def test_large_directory_is_bounded(self):
        item = SimpleNamespace(filename="a", st_mode=stat.S_IFREG, st_size=0)
        self.sftp.listdir_iter.return_value = iter([item] * 2001)
        with self.assertRaises(ValueError):
            operate(self.client, {"action": "list"})

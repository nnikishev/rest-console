"""Bounded-memory, per-WebSocket SFTP transfers. No total file-size limit."""

import base64
import binascii
import posixpath
import shutil
import stat
import tempfile
import uuid
import zipfile

CHUNK_SIZE = 256 * 1024


def archive_directory(sftp, path, output):
    root = posixpath.basename(path.rstrip("/")) or "directory"
    if root in (".", "..") or "\\" in root or "\0" in root:
        root = "directory"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        pending = [(path, root)]
        while pending:
            remote_path, archive_path = pending.pop()
            archive.writestr(archive_path + "/", b"")
            for item in sftp.listdir_iter(remote_path):
                name = item.filename
                if name in (".", "..") or "/" in name or "\\" in name or "\0" in name:
                    raise ValueError("Небезопасное имя элемента архива.")
                source = posixpath.join(remote_path, name)
                target = archive_path + "/" + name
                if stat.S_ISDIR(item.st_mode or 0):
                    pending.append((source, target))
                elif stat.S_ISREG(item.st_mode or 0):
                    with (
                        sftp.open(source, "rb") as remote,
                        archive.open(target, "w", force_zip64=True) as dest,
                    ):
                        shutil.copyfileobj(remote, dest, CHUNK_SIZE)
                # Never follow symlinks or read special files.
    size = output.tell()
    output.seek(0)
    return root + ".zip", size


class Transfers:
    def __init__(self):
        self.items = {}

    def operate(self, client, data):
        action = data.get("action")
        if action == "transfer_start":
            if self.items:
                raise ValueError("Дождитесь завершения текущей передачи или отмените её.")
            path = data.get("path")
            mode = data.get("mode")
            if not isinstance(path, str) or not path or len(path) > 4096 or "\0" in path:
                raise ValueError("Некорректный путь.")
            if mode not in ("upload", "download", "archive"):
                raise ValueError("Некорректный тип передачи.")
            sftp = client.open_sftp()
            remote = None
            created = False
            try:
                sftp.get_channel().settimeout(30)
                path = sftp.normalize(path) if mode != "upload" else path
                name = posixpath.basename(path)
                if mode == "upload":
                    size = data.get("size")
                    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                        raise ValueError("Некорректный размер файла.")
                    remote = sftp.open(path, "wx")
                    created = True
                elif mode == "download":
                    if not stat.S_ISREG(sftp.stat(path).st_mode):
                        raise ValueError("Скачивать можно только обычные файлы.")
                    remote = sftp.open(path, "rb")
                    size = remote.stat().st_size or 0
                else:
                    if not stat.S_ISDIR(sftp.lstat(path).st_mode):
                        raise ValueError("Выберите каталог.")
                    remote = tempfile.TemporaryFile()
                    name, size = archive_directory(sftp, path, remote)
                token = uuid.uuid4().hex
                self.items[token] = {
                    "sftp": sftp,
                    "file": remote,
                    "path": path,
                    "mode": mode,
                    "size": size,
                    "offset": 0,
                }
                return {"token": token, "name": name, "size": size, "chunk_size": CHUNK_SIZE}
            except BaseException:
                if remote is not None:
                    remote.close()
                if created:
                    try:
                        sftp.remove(path)
                    except OSError:
                        pass
                sftp.close()
                raise
        token = data.get("token")
        if not isinstance(token, str) or token not in self.items:
            raise ValueError("Передача недоступна.")
        item = self.items[token]
        try:
            if action == "transfer_cancel":
                self.close(token, remove=True)
                return {"cancelled": True}
            if action == "transfer_finish":
                if item["mode"] == "upload" and item["offset"] != item["size"]:
                    raise ValueError("Файл передан не полностью.")
                item["file"].flush() if item["mode"] == "upload" else None
                self.close(token)
                return {"finished": True}
            if action != "transfer_chunk":
                raise ValueError("Неизвестная операция передачи.")
            if item["mode"] == "upload":
                content = data.get("content")
                if not isinstance(content, str) or len(content) > 4 * ((CHUNK_SIZE + 2) // 3):
                    raise ValueError("Слишком большой блок передачи.")
                try:
                    raw = base64.b64decode(content, validate=True)
                except (ValueError, binascii.Error):
                    raise ValueError("Некорректный блок передачи.") from None
                if not raw or len(raw) > CHUNK_SIZE or item["offset"] + len(raw) > item["size"]:
                    raise ValueError("Некорректный размер блока.")
                item["file"].write(raw)
                item["offset"] += len(raw)
                return {"offset": item["offset"]}
            raw = item["file"].read(CHUNK_SIZE)
            item["offset"] += len(raw)
            return {
                "content": base64.b64encode(raw).decode("ascii"),
                "offset": item["offset"],
                "eof": not raw,
            }
        except BaseException:
            self.close(token, remove=True)
            raise

    def close(self, token, remove=False):
        item = self.items.pop(token)
        try:
            item["file"].close()
        finally:
            try:
                if remove and item["mode"] == "upload":
                    item["sftp"].remove(item["path"])
            finally:
                item["sftp"].close()

    def shutdown(self):
        for token in list(self.items):
            try:
                self.close(token, remove=True)
            except (OSError, EOFError):
                pass

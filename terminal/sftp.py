import base64
import binascii
import hashlib
import io
import posixpath
import re
import stat
import time
import zipfile

from config.settings import LIMIT, PREVIEW_LIMIT


def directory_archive(sftp, path):
    output = io.BytesIO()
    total = 0
    count = 0
    deadline = time.monotonic() + 45
    root = posixpath.basename(path.rstrip("/")) or "directory"
    if root in (".", "..") or "\\" in root or "\0" in root:
        root = "directory"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:

        def walk(remote_path, archive_path, depth):
            nonlocal total, count
            if depth > 32:
                raise ValueError("Слишком большая глубина каталогов (максимум 32).")
            archive.writestr(archive_path + "/", b"")
            for item in sftp.listdir_iter(remote_path):
                count += 1
                if count > 2000 or time.monotonic() > deadline:
                    raise ValueError("Архив превышает лимит 2000 элементов или время обработки.")
                name = item.filename
                if name in (".", "..") or "/" in name or "\\" in name or "\0" in name:
                    raise ValueError("Небезопасное имя элемента архива.")
                source = posixpath.join(remote_path, name)
                target = archive_path + "/" + name
                if stat.S_ISDIR(item.st_mode or 0):
                    walk(source, target, depth + 1)
                elif stat.S_ISREG(item.st_mode or 0):
                    if (item.st_size or 0) > LIMIT - total:
                        raise ValueError("Суммарный размер файлов каталога превышает 5 МиБ.")
                    with sftp.open(source, "rb") as remote:
                        content = remote.read(LIMIT - total + 1)
                    total += len(content)
                    if total > LIMIT:
                        raise ValueError("Суммарный размер файлов каталога превышает 5 МиБ.")
                    archive.writestr(target, content)
                # Do not follow symlinks or read devices, sockets and FIFOs.
                if output.tell() > LIMIT:
                    raise ValueError("Размер ZIP-архива превышает 5 МиБ.")

        walk(path, root, 0)
    content = output.getvalue()
    if len(content) > LIMIT:
        raise ValueError("Размер ZIP-архива превышает 5 МиБ.")
    return {"name": root + ".zip", "content": base64.b64encode(content).decode("ascii")}


def operate(client, data):
    """Use the authenticated SSH transport; remote permissions apply to every path."""
    path = data.get("path", ".")
    if not isinstance(path, str) or not path or len(path) > 4096 or "\0" in path:
        raise ValueError("Некорректный путь.")
    with client.open_sftp() as sftp:
        sftp.get_channel().settimeout(20)
        action = data.get("action")
        if action == "services":
            services = []
            for index, item in enumerate(sftp.listdir_iter("/etc/systemd/system")):
                if index >= 10000:
                    raise ValueError("Слишком много записей в /etc/systemd/system.")
                if re.fullmatch(r"[A-Za-z0-9_@:.-]+\.service", item.filename) and (
                    stat.S_ISREG(item.st_mode or 0) or stat.S_ISLNK(item.st_mode or 0)
                ):
                    services.append(item.filename)
                if len(services) > 2000:
                    raise ValueError("Слишком много сервисов.")
            return {"services": sorted(set(services))}
        if action == "list":
            path = sftp.normalize(path)
            entries = []
            for item in sftp.listdir_iter(path):
                if len(entries) >= 2000:
                    raise ValueError("В каталоге больше 2000 записей. Откройте подкаталог по пути.")
                entries.append(
                    {
                        "name": item.filename,
                        "directory": stat.S_ISDIR(item.st_mode or 0),
                        "size": item.st_size or 0,
                    }
                )
            entries.sort(key=lambda item: (not item["directory"], item["name"].lower()))
            return {"path": path, "entries": entries}
        if action == "archive":
            path = sftp.normalize(path)
            if not stat.S_ISDIR(sftp.lstat(path).st_mode):
                raise ValueError("Выберите каталог.")
            return directory_archive(sftp, path)
        if action == "preview":
            if not stat.S_ISREG(sftp.stat(path).st_mode):
                raise ValueError("Предпросмотр доступен только для обычных файлов.")
            with sftp.open(path, "rb") as remote:
                content = remote.read(PREVIEW_LIMIT + 1)
            return {
                "name": posixpath.basename(path),
                "content": base64.b64encode(content[:PREVIEW_LIMIT]).decode("ascii"),
                "revision": hashlib.sha256(content).hexdigest()
                if len(content) <= PREVIEW_LIMIT
                else None,
                "limit": PREVIEW_LIMIT,
                "truncated": len(content) > PREVIEW_LIMIT,
            }
        if action == "save":
            text = data.get("text")
            revision = data.get("revision")
            if not isinstance(text, str) or not isinstance(revision, str):
                raise ValueError("Некорректные данные редактора.")
            raw = text.encode("utf-8")
            if len(raw) > PREVIEW_LIMIT or "\0" in text:
                raise ValueError("Файл превышает лимит редактора или содержит бинарные данные.")
            if not stat.S_ISREG(sftp.stat(path).st_mode):
                raise ValueError("Редактировать можно только обычные файлы.")
            with sftp.open(path, "r+b") as remote:
                current = remote.read(PREVIEW_LIMIT + 1)
                if len(current) > PREVIEW_LIMIT or hashlib.sha256(current).hexdigest() != revision:
                    raise ValueError(
                        "Файл изменился на сервере. Откройте его заново перед сохранением."
                    )
                try:
                    current.decode("utf-8")
                except UnicodeDecodeError:
                    raise ValueError("Редактирование доступно только для UTF-8.") from None
                if b"\0" in current:
                    raise ValueError("Редактирование бинарных файлов запрещено.")
                remote.seek(0)
                remote.write(raw)
                remote.truncate(len(raw))
                remote.flush()
            return {"revision": hashlib.sha256(raw).hexdigest(), "saved": True}
        if action == "download":
            with sftp.open(path, "rb") as remote:
                if (remote.stat().st_size or 0) > LIMIT:
                    raise ValueError("Максимальный размер файла — 5 МиБ.")
                content = remote.read(LIMIT + 1)
            if len(content) > LIMIT:
                raise ValueError("Максимальный размер файла — 5 МиБ.")
            return {
                "name": posixpath.basename(path),
                "content": base64.b64encode(content).decode("ascii"),
            }
        if action == "upload":
            content = data.get("content", "")
            if not isinstance(content, str) or len(content) > 4 * ((LIMIT + 2) // 3):
                raise ValueError("Максимальный размер файла — 5 МиБ.")
            try:
                raw = base64.b64decode(content, validate=True)
            except (ValueError, binascii.Error):
                raise ValueError("Некорректное содержимое файла.") from None
            if len(raw) > LIMIT:
                raise ValueError("Максимальный размер файла — 5 МиБ.")
            # Exclusive creation prevents accidental overwrites, including symlinks.
            with sftp.open(path, "wx") as remote:
                remote.write(raw)
            return {"uploaded": True}
        raise ValueError("Неизвестная операция SFTP.")

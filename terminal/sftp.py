import base64
import hashlib
import posixpath
import re
import stat

from config.settings import PREVIEW_LIMIT


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
        raise ValueError("Неизвестная операция SFTP.")

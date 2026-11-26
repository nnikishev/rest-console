import asyncio
import base64
import hashlib
import hmac
import io
import socket

import paramiko
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.conf import settings

from .key_storage import decrypt_key
from .models import SavedConnection
from .sftp import operate


class HostConfirmationRequired(paramiko.SSHException):
    def __init__(self, fingerprint):
        self.fingerprint = fingerprint


class FingerprintPolicy(paramiko.MissingHostKeyPolicy):
    def __init__(self, expected):
        self.expected = expected

    def missing_host_key(self, client, hostname, key):
        fingerprint = "SHA256:" + base64.b64encode(
            hashlib.sha256(key.asbytes()).digest()
        ).decode().rstrip("=")
        if not self.expected:
            raise HostConfirmationRequired(fingerprint)
        if not hmac.compare_digest(self.expected, fingerprint):
            raise paramiko.SSHException("Отпечаток сервера изменился. Подключение заблокировано.")


class TerminalConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.client = None
        self.channel = None
        self.reader = None
        self.connecting = False
        if not self.scope["user"].is_authenticated:
            await self.close(code=4401)
            return
        await self.accept()

    async def receive_json(self, content, **kwargs):
        if not isinstance(content, dict):
            return
        kind = content.get("type")
        try:
            if kind == "connect" and not self.channel and not self.connecting:
                self.connecting = True
                try:
                    await self.open_ssh(content)
                finally:
                    self.connecting = False
            elif kind == "input" and self.channel:
                data = content.get("data", "")
                if isinstance(data, str) and len(data) <= 16384:
                    await asyncio.to_thread(self.channel.sendall, data.encode())
            elif kind == "resize" and self.channel:
                cols, rows = self.dimensions(content)
                await asyncio.to_thread(self.channel.resize_pty, width=cols, height=rows)
            elif kind == "sftp":
                try:
                    if not self.client or not self.channel:
                        raise ValueError("Сначала подключитесь к SSH.")
                    result = await asyncio.to_thread(operate, self.client, content)
                    await self.send_json(
                        {"type": "sftp", "id": content.get("id"), "result": result}
                    )
                except ValueError as exc:
                    await self.send_json(
                        {"type": "sftp", "id": content.get("id"), "error": str(exc)}
                    )
                except (OSError, EOFError, paramiko.SSHException):
                    await self.send_json(
                        {
                            "type": "sftp",
                            "id": content.get("id"),
                            "error": "Операция SFTP не выполнена: проверьте путь, права, лимит 5 МиБ и отсутствие файла при загрузке.",
                        }
                    )
            elif kind == "disconnect":
                await self.shutdown()
                await self.send_json({"type": "closed"})
        except HostConfirmationRequired as exc:
            await self.shutdown()
            await self.send_json({"type": "verify", "fingerprint": exc.fingerprint})
        except paramiko.AuthenticationException:
            await self.fail("Ошибка аутентификации. Проверьте имя пользователя, пароль или ключ.")
        except (ValueError, paramiko.SSHException) as exc:
            await self.fail(str(exc))
        except (OSError, EOFError, TimeoutError):
            await self.fail("Сервер недоступен или соединение прервано.")

    @staticmethod
    def dimensions(data):
        return max(20, min(400, int(data.get("cols", 100)))), max(
            5, min(200, int(data.get("rows", 30)))
        )

    @database_sync_to_async
    def saved_key(self, pk):
        if not isinstance(pk, int) or isinstance(pk, bool):
            raise ValueError("Некорректная закладка.")
        try:
            connection = SavedConnection.objects.get(pk=pk, owner=self.scope["user"])
        except SavedConnection.DoesNotExist:
            raise ValueError("Закладка недоступна.") from None
        if not connection.encrypted_key:
            raise ValueError("В закладке нет сохранённого ключа.")
        return connection, decrypt_key(connection.encrypted_key)

    async def open_ssh(self, data):
        key_text = data.get("key", "")
        if data.get("saved_connection_id") is not None:
            connection, key_text = await self.saved_key(data["saved_connection_id"])
            data = {
                **data,
                "host": connection.host,
                "port": connection.port,
                "username": connection.username,
            }
        host = str(data.get("host", "")).strip()
        username = str(data.get("username", "")).strip()
        port = int(data.get("port", 22))
        if (
            not host
            or not username
            or len(host) > 253
            or len(username) > 128
            or not 1 <= port <= 65535
        ):
            raise ValueError("Укажите корректные host, port и username.")
        if settings.SSH_ALLOWED_HOSTS and host not in settings.SSH_ALLOWED_HOSTS:
            raise ValueError("Этот сервер не включён в SSH_ALLOWED_HOSTS.")
        if not isinstance(key_text, str) or len(key_text.encode("utf-8")) > 65536:
            raise ValueError("Размер ключа не должен превышать 64 КБ.")
        password = data.get("password") or None
        if password is not None and (not isinstance(password, str) or len(password) > 4096):
            raise ValueError("Некорректный пароль.")
        cols, rows = self.dimensions(data)
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(FingerprintPolicy(str(data.get("fingerprint", ""))))
        self.client = client

        def establish():
            key = None
            if key_text:
                for key_class in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
                    try:
                        key = key_class.from_private_key(io.StringIO(key_text), password=password)
                        break
                    except paramiko.PasswordRequiredException:
                        raise ValueError(
                            "Для зашифрованного ключа требуется парольная фраза."
                        ) from None
                    except paramiko.SSHException:
                        continue
                if key is None:
                    raise ValueError(
                        "Не удалось прочитать приватный ключ или неверна парольная фраза."
                    )
            elif not password:
                raise ValueError("Укажите пароль или приватный ключ.")
            client.connect(
                hostname=host,
                port=port,
                username=username,
                password=password if not key else None,
                pkey=key,
                look_for_keys=False,
                allow_agent=False,
                timeout=12,
                auth_timeout=12,
                banner_timeout=12,
            )
            transport = client.get_transport()
            transport.set_keepalive(30)
            channel = client.invoke_shell(term="xterm-256color", width=cols, height=rows)
            channel.settimeout(0.5)
            return channel

        self.channel = await asyncio.to_thread(establish)
        await self.send_json({"type": "connected"})
        self.reader = asyncio.create_task(self.read_output())

    async def read_output(self):
        import codecs

        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        try:
            while self.channel:
                try:
                    chunk = await asyncio.to_thread(self.channel.recv, 16384)
                except socket.timeout:
                    continue
                if not chunk:
                    break
                await self.send_json({"type": "output", "data": decoder.decode(chunk)})
            await self.send_json({"type": "closed"})
        except (OSError, EOFError, paramiko.SSHException):
            await self.send_json({"type": "closed"})
        finally:
            if self.client:
                self.client.close()
            self.channel = None
            self.client = None

    async def fail(self, message):
        await self.shutdown()
        await self.send_json({"type": "error", "message": message})

    async def shutdown(self):
        if self.reader and self.reader is not asyncio.current_task():
            self.reader.cancel()
            try:
                await self.reader
            except asyncio.CancelledError:
                pass
        self.reader = None
        if self.client:
            self.client.close()
        self.client = None
        self.channel = None

    async def disconnect(self, code):
        await self.shutdown()

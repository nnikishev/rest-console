from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings


def cipher():
    secret = settings.SSH_KEY_ENCRYPTION_KEY
    if not secret:
        raise ValueError("Для сохранения ключей настройте SSH_KEY_ENCRYPTION_KEY на сервере.")
    try:
        return Fernet(secret.encode("ascii"))
    except (ValueError, UnicodeError):
        raise ValueError("Некорректный SSH_KEY_ENCRYPTION_KEY на сервере.") from None


def encrypt_key(value):
    if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > 65536:
        raise ValueError("Приватный ключ должен быть непустым и не превышать 64 КБ.")
    if "PRIVATE KEY-----" not in value:
        raise ValueError("Выберите приватный ключ OpenSSH или PEM.")
    return cipher().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_key(value):
    try:
        return cipher().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError):
        raise ValueError(
            "Не удалось расшифровать сохранённый ключ. Проверьте ключ шифрования сервера."
        ) from None

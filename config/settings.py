import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "development-only-change-before-deployment")
DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"
if not DEBUG and SECRET_KEY == "development-only-change-before-deployment":
    raise RuntimeError("Set DJANGO_SECRET_KEY in production")
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
INSTALLED_APPS = [
    "daphne",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    "terminal",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
ASGI_APPLICATION = "config.asgi.application"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.template.context_processors.csrf",
            ]
        },
    }
]
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}
STATIC_URL = "/static/"
STATICFILES_DIRS = [BASE_DIR / "frontend" / "dist"]
STATIC_ROOT = BASE_DIR / "staticfiles"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 10},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
LANGUAGE_CODE = "ru"
LOGIN_URL = "/login/"
LOGIN_REDIRECT_URL = "/"
LOGOUT_REDIRECT_URL = "/login/"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Strict"
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
SSH_KEY_ENCRYPTION_KEY = os.environ.get(
    "SSH_KEY_ENCRYPTION_KEY", "7Kyce_bPmSqiBdCjOdoDD8Lj3_LLMmidzDhLEq11-1A="
)
SSH_ALLOWED_HOSTS = [
    h.strip() for h in os.environ.get("SSH_ALLOWED_HOSTS", "").split(",") if h.strip()
]
LIMIT = 150 * 1024 * 1024
PREVIEW_LIMIT = 1024 * 1024

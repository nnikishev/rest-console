from django.contrib.auth import views as auth_views
from django.urls import path

from terminal import views

urlpatterns = [
    path("", views.terminal_page),
    path("api/quick-commands/", views.quick_commands),
    path("api/quick-commands/<int:pk>/", views.delete_quick_command),
    path("api/connections/", views.connections),
    path("api/connections/<int:pk>/", views.delete_connection),
    path("login/", auth_views.LoginView.as_view(template_name="login.html")),
    path("logout/", auth_views.LogoutView.as_view()),
]

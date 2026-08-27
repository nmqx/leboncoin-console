#!/bin/sh
# Bureau X virtuel + noVNC, puis la console. Le navigateur lancé par la console
# (« Ouvrir Chrome & se connecter ») s'affiche sur ce bureau, visible depuis le
# web sur /vnc/ — c'est ainsi qu'on se connecte à Leboncoin sans écran ici.
set -e

Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" -nolisten tcp &
for i in $(seq 1 40); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.25
done

openbox --sm-disable >/dev/null 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet -bg -rfbport 5900 >/dev/null 2>&1
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/dev/null 2>&1 &

exec "$@"

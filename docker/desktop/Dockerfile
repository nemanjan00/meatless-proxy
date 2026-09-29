# syntax=docker/dockerfile:1
# The desktop sidecar of an environment started with `env.up { desktop: true }`: a virtual display
# (Xvfb), a VNC server on it and a WebSocket bridge, run next to the environment's main container in
# its network namespace (Docker's `container:` network mode). Programs in the main container draw on
# the display with DISPLAY=:99 (the X server's abstract socket is shared with the network namespace).
#
# - Xvfb :99, no TCP listener.
# - x11vnc on 127.0.0.1:5900 (control) and 127.0.0.1:5901 (view-only, `-viewonly`): localhost only,
#   no password; the WebSocket bridges below are the only way in.
# - websockify on :6080 → 5900 and :6081 → 5901, reached only through the harness's preview
#   forwarder and the preview origin's signed, scoped cookies.
# - mp-desktop-shot prints a PNG screenshot of the display as base64 (env.screenshot).
#
# Build: docker build -t mp-desktop docker/desktop

FROM alpine:3.22

# hadolint ignore=DL3018
RUN apk add --no-cache xvfb x11vnc python3 scrot xdpyinfo xsetroot \
  && apk add --no-cache --virtual .build py3-pip \
  && pip install --no-cache-dir --no-deps --break-system-packages websockify==0.13.0 \
  && apk del .build \
  && addgroup -g 1000 desktop \
  && adduser -u 1000 -G desktop -h /tmp -H -D -s /sbin/nologin desktop

COPY --chmod=0755 mp-desktop mp-desktop-shot /usr/local/bin/

ENV HOME=/tmp \
    DISPLAY=:99 \
    DESKTOP_SIZE=1440x900

USER 1000:1000
WORKDIR /tmp
EXPOSE 6080 6081
ENTRYPOINT ["/usr/local/bin/mp-desktop"]

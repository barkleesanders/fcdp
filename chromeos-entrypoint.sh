#!/usr/bin/env bash
set -euo pipefail

Xvfb :99 -screen 0 1280x800x24 +extension GLX -nolisten tcp >/tmp/xvfb.log 2>&1 &
socat TCP-LISTEN:9334,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9333 \
  >/tmp/socat.log 2>&1 &

for _ in {1..100}; do
  [[ -S /tmp/.X11-unix/X99 ]] && break
  sleep 0.05
done
if [[ ! -S /tmp/.X11-unix/X99 ]]; then
  printf 'Xvfb did not publish display :99\n' >&2
  exit 2
fi

export DISPLAY=:99
export LIBGL_ALWAYS_SOFTWARE=1
export MESA_LOADER_DRIVER_OVERRIDE=llvmpipe
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json

exec /opt/chrome/chrome \
  --no-sandbox \
  --use-gl=angle \
  --use-angle=default \
  --enable-features=AllowSoftwareGLFallbackDueToCrashes \
  --form-factor=OTHER \
  --bwsi \
  --incognito \
  --login-user=\$guest \
  --login-profile=user \
  --remote-debugging-port=9333 \
  --user-data-dir=/tmp/fcdp-profile \
  about:blank

#!/bin/sh
set -eu

: "${CMUX_WS_TOKEN:=agentmonitor-prototype}"

mkdir -p /state/session /state/omp-agent "$HOME/.omp"
ln -sfn /state/omp-agent "$HOME/.omp/agent"
node /usr/local/bin/service-relay.mjs &
exec cmux \
  --headless \
  --session prototype \
  --state /state/session \
  --ws 0.0.0.0:7681 \
  --ws-insecure-bind \
  --ws-token "$CMUX_WS_TOKEN"

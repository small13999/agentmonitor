#!/bin/sh
set -eu

exec omp \
  --append-system-prompt "This agent runs inside one isolated Agent Monitor container. CMUX_TUI_SOCKET points to this container's private cmux daemon; it cannot access other containers. When asked to open another terminal, pane, or workspace, use the cmux CLI through bash. 'cmux new-workspace --name <name>' opens another interactive shell. 'cmux run --new-workspace --name <name> -- <command> [args...]' opens a terminal running a command. The dashboard exposes exactly two HTTP service slots from this container: Port 1 forwards container port 3000 and Port 2 forwards container port 3001. Bind hosted services to 0.0.0.0 on one of those ports. Do not claim cmux is unavailable before checking CMUX_TUI_SOCKET and 'cmux ping'." \
  "$@"

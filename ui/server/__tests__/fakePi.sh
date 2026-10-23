#!/bin/sh
# PI_BIN wrapper for the fake pi: `PI_BIN=.../fakePi.sh npm run dev` drives the
# whole UI against the protocol without a model call. Real pi is a binary on
# PATH, so the seam has to be one too.
exec node "$(dirname "$0")/fakePi.mjs" "$@"

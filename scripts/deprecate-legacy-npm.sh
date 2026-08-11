#!/usr/bin/env bash
# Signpost the npmjs versions that reach for the now-private model libraries.
#
# WHY DEPRECATE RATHER THAN UNPUBLISH
# Not a preference — npm will not remove these. Self-service unpublish needs no
# dependents and under 300 weekly downloads; every one of these has both a
# dependent and far more traffic than that (the core alone runs ~2000/week).
# Removal would take an npm support request.
#
# WHAT DEPRECATION DOES AND DOES NOT DO
# It prints a warning on install. It does NOT change a published manifest, so
# these versions still declare `jax-ai-js` / `yolo-segdetect-js` and still pull
# them from npmjs. The actual fix is **0.3.0**, which depends on neither; this
# script only stops someone reaching for the old line by accident.
#
# Nothing here is a new exposure: what was private is the model weights, which
# lived on HuggingFace, not this library's source.
#
# Needs `npm login` first.
set -euo pipefail

CORE='@jax-data-science/sci-image-visualizer'
NEW_MSG="Depends on model libraries that moved to jax-cs-registry. Use ${CORE}@^0.3.0 with @jax-data-science/sci-image-visualizer-jax-tools."

# Every published 0.2.x declares yolo-segdetect-js; 0.2.17+ also jax-ai-js.
# One list, used for both the deprecation and the verification below -- two
# copies would silently drift.
LEGACY=(0.2.14 0.2.15 0.2.16 0.2.17 0.2.18 0.2.19)

for v in "${LEGACY[@]}"; do
  echo "==> deprecating ${CORE}@${v}"
  npm deprecate "${CORE}@${v}" "$NEW_MSG"
done

echo "==> deprecating the two libraries themselves"
npm deprecate jax-ai-js \
  'Moved to @jax-data-science/jax-ai-js on jax-cs-registry (https://us-npm.pkg.dev/jax-cs-registry/npm/).'
npm deprecate yolo-segdetect-js \
  'Moved to @jax-data-science/yolo-segdetect-js on jax-cs-registry (https://us-npm.pkg.dev/jax-cs-registry/npm/).'

echo
echo "==> verifying"
# Per version, not per package. `npm view <pkg> deprecated` reports only the
# dist-tag'd latest, which is 0.3.0 and deliberately NOT deprecated -- so the
# obvious one-line check would print an empty result and read as success while
# every version this script targets went untouched.
fail=0
for v in "${LEGACY[@]}"; do
  msg=$(npm view "${CORE}@${v}" deprecated 2>/dev/null || true)
  if [ -z "$msg" ]; then
    echo "  MISSING ${CORE}@${v}"
    fail=1
  else
    echo "  ok      ${CORE}@${v}"
  fi
done
for p in jax-ai-js yolo-segdetect-js; do
  # A whole-package deprecation lands on every version, so check the versions
  # rather than the package: an empty reply here would also be a false pass.
  for v in $(npm view "$p" versions --json 2>/dev/null | tr -d '[]", ' | tr '\n' ' '); do
    [ -z "$v" ] && continue
    msg=$(npm view "$p@$v" deprecated 2>/dev/null || true)
    if [ -z "$msg" ]; then echo "  MISSING $p@$v"; fail=1; fi
  done
  echo "  checked $p"
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Some deprecations did not take. Re-run, or check you are logged in as a maintainer." >&2
  exit 1
fi
echo "All targeted versions are deprecated."

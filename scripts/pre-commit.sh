#!/bin/sh
# Stamp build.txt with the commit being made, and include it in that commit.
#
# INSTALL: cp scripts/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#
# A hook cannot be tracked by git, so this file is the versioned copy and the hook is an
# installed copy of it. They can drift; if the stamping behaviour changes, change this and
# copy it again.
#
# WHY THIS EXISTS. `npm run sync` ran the stamp, but committing did not, so build.txt
# drifted seven commits behind HEAD while every commit claimed to describe code the
# running game could identify. A stamp that lags by seven commits answers a question
# nobody asked.
#
# THE SECOND HALF IS THE EASY ONE TO MISS. A file written during `pre-commit` is not in
# the commit being made unless it is staged AFTER being written. Stamping without
# re-adding leaves the new value for the NEXT commit — the same drift, one step removed.
set -e

node scripts/stamp-build.mjs

if git ls-files --error-unmatch src/game/build.txt >/dev/null 2>&1; then
    git add src/game/build.txt
fi

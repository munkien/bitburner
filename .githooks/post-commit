#!/bin/sh
# Stamp build.txt with THIS commit's hash, then fold the stamp into it.
#
# INSTALL: cp scripts/post-commit.sh .git/hooks/post-commit && chmod +x .git/hooks/post-commit
#
# WHY post-commit AND NOT pre-commit. A pre-commit hook runs before the commit exists, so
# `git rev-parse HEAD` still returns the parent — the stamp would always name the previous
# commit. Measured: a commit made with such a hook landed as 618ab51 while build.txt said
# f3f03c6. Only after the commit does its own hash exist.
#
# WHY THE AMEND. The commit has already captured the old build.txt by the time this runs,
# so the correct value has to be folded back in. `--amend --no-edit` keeps the message and
# changes only the tree.
#
# THE GUARD MATTERS. Amending triggers post-commit again. If build.txt already holds this
# commit's stamp, there is nothing to do and the hook exits — without that check this
# would recurse until git gave up.
set -e

hash=$(git rev-parse --short HEAD)
state=$(git status --porcelain)
wanted="$hash"

# Nothing to do when build.txt already names this commit.
if [ -f src/game/build.txt ] && head -n1 src/game/build.txt | grep -q "^$wanted"; then
    exit 0
fi

node scripts/stamp-build.mjs

# Only amend when the stamp actually changed something, so a hook that cannot write
# the file does not rewrite the commit for nothing.
if [ -n "$(git status --porcelain src/game/build.txt)" ]; then
    git add src/game/build.txt
    git commit --amend --no-edit --quiet
fi

exit 0

#!/bin/bash
#
# One step of somebody else's program, inside a microVM that exists for this
# run and nothing else.
#
#   run.sh step <seconds> <processes> <file-bytes> -- <command> [args...]
#   run.sh oom
#
# The backend uploads this file beside the source and the input, and calls it
# as root through the SDK's sudo. Root is only needed to set things up: the
# program itself runs as `nobody`, in /work, with an environment built from
# nothing and hard limits on what it may start and write.
#
# None of that is the boundary. The boundary is the machine, which has no
# network and is deleted the moment the run is over. This is the second fence
# behind it — the reason a fork bomb is an ordinary failed run rather than a
# machine too busy to report what happened, and the reason a program cannot
# rewrite this script between the compile step and the run step.

set -u

# Where the backend put this script, the source and the input.
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# `nobody` and `nogroup` on every Ubuntu image. Numbers rather than names so
# that a missing passwd entry fails loudly here instead of quietly running the
# program as somebody else.
NOBODY=65534

case "${1:-}" in
  oom)
    # Whether the kernel killed anything for memory during this machine's
    # short life. Asked only after a program died of SIGKILL: the exit code
    # alone cannot tell "ran out of memory" from "killed itself", and only one
    # of those is something a person can fix. A machine that has run exactly
    # one program has exactly one suspect.
    dmesg 2>/dev/null | grep -qiE 'out of memory|oom-kill|killed process'
    exit $?
    ;;
  step)
    shift
    ;;
  *)
    echo 'usage: run.sh step <seconds> <processes> <file-bytes> -- <command> [args...]' >&2
    exit 64
    ;;
esac

if [ "$#" -lt 5 ] || [ "$4" != '--' ]; then
  echo 'usage: run.sh step <seconds> <processes> <file-bytes> -- <command> [args...]' >&2
  exit 64
fi

seconds=$1
processes=$2
filebytes=$3
shift 4

# The first step moves the source into a directory only the program's user
# can use. It arrives owned by whoever the SDK writes as, in a directory the
# program must not be able to change — this script is run again, as root, for
# the second step of a compiled language.
if [ ! -e "$here/.prepared" ]; then
  # Whatever modes the upload gave it, only root may change it from here on.
  chown -R 0:0 "$here" && chmod -R go-w "$here" || exit 70
  install -d -o "$NOBODY" -g "$NOBODY" -m 0700 /work || exit 70
  for file in "$here"/src/*; do
    install -o "$NOBODY" -g "$NOBODY" -m 0644 "$file" /work/ || exit 70
  done
  touch "$here/.prepared"
fi

cd /work || exit 70

# If the machine does run out of memory, the program is what the kernel
# reaches for first, rather than the agent that reports back what happened.
echo 1000 > /proc/self/oom_score_adj 2>/dev/null || true

# From the outside in:
#
#   timeout    the wall clock. TERM at the deadline, KILL a second later for a
#              program that ignores TERM, and the whole process group either
#              way, so children go with their parent.
#   prlimit    processes (a fork bomb stops at the ceiling instead of taking
#              the machine), the size of any one file (the disk cannot be
#              filled through the working directory), open files, no cores.
#   setpriv    nobody, with no supplementary groups, no capabilities left in
#              the bounding set, and no_new_privs — so neither sudo nor any
#              other setuid binary can undo the rest.
#   env -i     nothing inherited. The toolchains get the few variables they
#              need and nothing else exists; HOME is /tmp because some of them
#              insist on writing somewhere.
#
# Not `exec`: this shell stays to hand back an ordinary exit status. A program
# that ignores TERM is killed along with `timeout` itself, and a parent dying
# of a signal is reported upstream as no exit code at all — which the SDK
# reads as zero. A timed-out program must never arrive as a clean exit.
#
# The shell's own stderr goes nowhere and the program's goes where this
# script's did. Otherwise bash narrates a killed child — "line 120: 27 Killed
# timeout --kill-after=1 ..." — into the middle of somebody's output, which is
# this script's business and nobody else's.
exec 3>&2 2>/dev/null

timeout --kill-after=1 "$seconds" \
  prlimit --nproc="$processes" --fsize="$filebytes" --nofile=256 --core=0 -- \
  setpriv --reuid="$NOBODY" --regid="$NOBODY" --clear-groups \
    --no-new-privs --inh-caps=-all --bounding-set=-all -- \
  env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/tmp \
    TMPDIR=/tmp \
    LANG=C.UTF-8 \
    XDG_CACHE_HOME=/tmp \
    GOCACHE=/opt/syncspace/go-cache \
    GOPATH=/tmp/go \
    GOTOOLCHAIN=local \
    GOFLAGS=-buildvcs=false \
    CARGO_HOME=/tmp/cargo \
    "$@" < "$here/stdin" 2>&3 3>&-

exit $?

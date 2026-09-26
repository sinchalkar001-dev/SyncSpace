#!/bin/bash
#
# Everything a run might need, installed once.
#
# This runs in a single builder machine, with network, and the machine is then
# saved as a snapshot that every run starts from. A run never installs
# anything: it has no network to install with, and a compiler download in
# front of every button press would not fit in a five-second budget anyway.
#
# The backend names the snapshot after a hash of this file, so changing
# anything here — a package, the warm-up below — builds a fresh one on the next
# start instead of quietly reusing the old.
#
# Each language reports what it installed on a `syncspace-version` line, which
# the backend reads out of this script's output and nowhere else.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Node.js is already here: the snapshot starts from Vercel's Node image. The
# rest comes from the Ubuntu archive, whose defaults are the versions a person
# gets from `apt install` on the same release — unremarkable on purpose.
apt-get update -q
apt-get install -y -q --no-install-recommends \
  python3 \
  default-jdk-headless \
  g++ \
  golang-go \
  rustc
apt-get clean
rm -rf /var/lib/apt/lists/*

# Go ships its standard library as source and compiles it into a cache on
# first use, so a machine with an empty cache spends most of `go run` building
# `fmt` — several seconds, every run, against a five-second limit. Building the
# packages people actually import here moves that cost into the snapshot.
#
# World-writable because Go refuses a cache it cannot write to, and harmless
# for the same reason everything else is: each machine runs one program and is
# thrown away.
install -d -m 0777 /opt/syncspace /opt/syncspace/go-cache

warm=$(mktemp -d)
cat > "$warm/main.go" <<'GO'
package main

import (
	"bufio"
	"bytes"
	"container/heap"
	"container/list"
	"errors"
	"fmt"
	"maps"
	"math"
	"math/big"
	"math/bits"
	"math/rand"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

func main() {
	var h heap.Interface
	_ = h
	_ = list.New()
	_ = bufio.NewReader(os.Stdin)
	_ = bytes.NewBuffer(nil)
	_ = errors.New("")
	_ = maps.Keys(map[int]int{})
	_ = math.MaxInt
	_ = big.NewInt(0)
	_ = bits.OnesCount(0)
	_ = rand.Intn(1)
	_ = regexp.MustCompile("")
	_ = slices.Contains([]int{}, 0)
	sort.Ints(nil)
	_ = strconv.Itoa(0)
	_ = strings.TrimSpace("")
	var mu sync.Mutex
	mu.Lock()
	mu.Unlock()
	_ = time.Now()
	_ = unicode.IsLetter('a')
	_ = utf8.RuneLen('a')
	fmt.Print("")
}
GO

(
  cd "$warm"
  GOCACHE=/opt/syncspace/go-cache GOPATH="$warm/gopath" GOTOOLCHAIN=local GOFLAGS=-buildvcs=false \
    go build -o "$warm/warm" main.go
)
rm -rf "$warm"
chmod -R a+rwX /opt/syncspace/go-cache

# Proof that each toolchain answers, and the version it answered with. A
# missing one fails the build here, loudly, rather than as a confusing error on
# somebody's first Run.
first_line() { head -n 1 | tr -d '\r'; }

echo "syncspace-version javascript $(node --version | first_line)"
echo "syncspace-version typescript $(node --version | first_line)"
echo "syncspace-version python $(python3 --version 2>&1 | first_line)"
echo "syncspace-version java $(java -version 2>&1 | first_line)"
echo "syncspace-version cpp $(g++ --version | first_line)"
echo "syncspace-version go $(go env GOVERSION | first_line)"
echo "syncspace-version rust $(rustc --version | first_line)"

# The run script's own tools. All three are part of the base system, and the
# run script is useless without any of them.
command -v timeout prlimit setpriv > /dev/null

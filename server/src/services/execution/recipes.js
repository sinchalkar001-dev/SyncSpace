import path from 'node:path'
import { isWindows } from './spawn.js'

/**
 * How each language becomes a process.
 *
 * Lifted out of the runner so both backends can read it. The commands are
 * written against a *context* rather than against this machine, because the
 * same recipe now has to work twice: once on the host, where a compiled binary
 * is `program.exe` and Python may be called `python`, and once inside a Linux
 * container, where it is `program` and `python3`. Baking the host's answers
 * into the recipe is what would force a second copy of this table, and a
 * second copy is how the two drift.
 */

/** What the host calls things. */
export const hostContext = (dir) => ({
  dir,
  binary: isWindows ? 'program.exe' : 'program',
  python: isWindows ? 'python' : 'python3',
  join: path.join,
})

/** What a Linux container calls things. `dir` is always the mount point. */
export const containerContext = (dir = '/work') => ({
  dir,
  binary: 'program',
  python: 'python3',
  join: path.posix.join,
})

export const RECIPES = {
  javascript: {
    file: 'main.js',
    run: () => ['node', ['main.js']],
    probe: ['node', ['--version']],
    toolchain: 'Node.js',
    image: 'node:22-alpine',
  },
  typescript: {
    file: 'main.ts',
    // Node strips the types and runs the JavaScript underneath; no tsc, and
    // so no type checking either.
    run: () => ['node', ['--experimental-strip-types', 'main.ts']],
    // Probing the flag rather than node itself: type stripping only exists
    // from Node 22.6, and an older runtime would otherwise advertise every
    // .ts buffer as runnable, then die on a confusing "bad option".
    probe: ['node', ['--experimental-strip-types', '-e', '']],
    toolchain: 'Node.js',
    image: 'node:22-alpine',
  },
  python: {
    file: 'main.py',
    // -u keeps output unbuffered, so a program killed on the timeout still
    // shows everything it had already printed.
    run: (c) => [c.python, ['-u', 'main.py']],
    probe: [isWindows ? 'python' : 'python3', ['--version']],
    toolchain: 'Python 3',
    image: 'python:3.12-alpine',
  },
  java: {
    file: 'Main.java',
    // Single-file source mode (JEP 330): compiled in memory, no javac step.
    run: () => ['java', ['Main.java']],
    probe: ['java', ['-version']],
    toolchain: 'JDK 11+',
    image: 'eclipse-temurin:21-jdk-alpine',
  },
  cpp: {
    file: 'main.cpp',
    compile: (c) => ['g++', ['-std=c++17', 'main.cpp', '-o', c.binary]],
    run: (c) => [c.join(c.dir, c.binary), []],
    probe: ['g++', ['--version']],
    toolchain: 'g++',
    image: 'gcc:14',
  },
  go: {
    file: 'main.go',
    run: () => ['go', ['run', 'main.go']],
    probe: ['go', ['version']],
    toolchain: 'Go',
    image: 'golang:1.23-alpine',
  },
  rust: {
    file: 'main.rs',
    compile: (c) => ['rustc', ['main.rs', '-o', c.binary]],
    run: (c) => [c.join(c.dir, c.binary), []],
    probe: ['rustc', ['--version']],
    toolchain: 'Rust',
    image: 'rust:1.82-alpine',
  },
}

export const RUNNABLE_LANGUAGES = Object.keys(RECIPES)

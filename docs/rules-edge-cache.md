# Persistent graph cache

`check`, `check <file>`, `todo`, `rules`, `recommend`, `fix`'s own baseline, and `search` all build
their module graph through one cached path. It reads and writes
`node_modules/.cache/archstrict/edges.json` (a header) plus a fixed 64 shard files under
`node_modules/.cache/archstrict/edges/` in the analyzed project - a file's own shard is a stable
hash of its own project-relative path. `simulate` never reads or writes this cache; it keeps its
own in-memory overlay instead.

A build rewrites only the shards whose own files actually changed, never the whole cache: a touch
or a one-file edit rewrites one shard plus the header. A shard that is missing, unreadable, or
whose bytes no longer match the header's own recorded hash for it makes only that shard's own
files a cache miss (re-walked and re-resolved); it is never an error, and it never discards the
rest of the cache.

The cache stores one entry per analyzed file, keyed by its absolute path: that file's own
syntactic import list (never its AST), its resolved specifiers, and the compiler options and
package.json "type" it was parsed under. It also stores a scan-only entry for each resolvable
TypeScript file outside analysis. That entry records top-level string-named module declarations.
A file whose own mtime, size, effective compiler options, and implied module format all still
match is not reparsed; only a changed or new file is reparsed, and only that one file.

Resolutions are reused outright while nothing that can affect a resolution answer has moved:
the analyzed file set, every package.json outside node_modules, the nearest lockfile, every
resolvable file outside node_modules (any extension a specifier could resolve to, whether
analyzed, excluded, or in dist/), every distinct effective compiler-options object, and the
node_modules package set on the path resolution actually walks (see below). The moment any of
these moves, every specifier is re-resolved project-wide from each file's own already-cached
import list - never a reparse of any file whose own mtime and size are unchanged.

The node_modules dependency set covers every node_modules directory this build meets: each
ancestor of the project root's own, all the way up to the filesystem root (the same distance
TypeScript's own resolver walks for a bare specifier, regardless of where a lockfile sits), and
every one the project's own tree walk meets while descending (a workspace member's own
node_modules, e.g. `packages/app/node_modules`), without ever descending into node_modules
itself. Each one records its own top-level package names and their package.json's own mtime,
read after following a symlink; a dot-prefixed entry (`.cache`, `.bin`, `.vite`, pnpm's own
`.pnpm` store) is never counted as a package name, so this cache's own
`node_modules/.cache/archstrict` does not move its own fingerprint. This covers a package
installed or removed with no lockfile edit, and a symlinked workspace package's own `exports`
edit. It does not cover an edit made directly to an already-installed package's own file, leaving
its package.json untouched - nothing this cache reads changes for that edit, and deleting
`node_modules/.cache/archstrict` is the only way to force a rebuild for it.

The reparse gate is mtime and size, not a content hash: an edit that keeps the exact same byte
size and whose mtime is restored (or never advances) is not detected either.

A package version mismatch, a change to this project's own built code (module-graph.js,
edge-cache.js), or a different installed typescript version drops the whole cache. A malformed
cache file is a silent miss, not an error; writes are atomic (a temporary file, then a rename),
and a failed write leaves the fresh analysis result usable regardless.

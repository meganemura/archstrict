# Edge cache for path queries

`rules <path>` needs module membership and resolved edges, but does not need type information.
It uses `node_modules/.cache/archstrict/edges.json` in the analyzed project.
`check` keeps its full analysis path. The shared graph creates its checker on first access.

The cache stores resolved edges per source file, source traversal order, and analysis diagnostics.
A hit rebuilds modules and graph relationships without creating a TypeScript Program or checker.
If a caller requests `program` or `checker` from that graph, a full analysis supplies them on demand.

A hit requires the same complete source path set and source mtimes, effective compiler options, tool version, and graph build options.
The compiler options hash includes the root options and each source file's nearest tsconfig options.
Build options include declarations, exclusions, and the surface setting, because these affect which files produce edges.

Package metadata also invalidates the whole cache:

- The root package.json and each declared module's package.json, at the same directory used for surface derivation.
- The first existing root lockfile, in this order: package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock.

Package file absence is recorded so creation and deletion also invalidate the cache.
Any mismatch triggers a full rebuild, with no partial reuse.
The cache uses mtimes rather than content hashes for source and package files.

Writes use a temporary file in the cache directory followed by a rename.
Malformed caches cause a rebuild; write failures leave the fresh analysis result usable.
The cache schema has its own version, separate from the package version.

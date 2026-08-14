# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Library and identity

### Library

A music folder the server indexes and a paired phone mirrors. One server process can host several isolated libraries; a phone paired to one library cannot see another.

### Track

One audio file in a library, published with tags, duration, and two identities: a location identity and a bytes identity.

### Track identity

Stable id for a track's location in the library: a hash of the relative path from the music root, using forward slashes. Renaming or moving the file mints a new identity and retires the old one.

### Content key

Identity of the file bytes: a hash of the first and last chunks plus the file size. Tag edits, re-encodes, and replacements change the content key even when the path (and therefore the track identity) stays the same.

### Manifest

The server's published snapshot of a library: server identity, a monotonic revision, and every track's identities plus tags. The phone diffs this against its local copy to decide what to download, move, or delete.

## Sync

### Rename rescue

When a desktop file is renamed, the old path disappears and a new path appears with the same content key. Sync can move the already-downloaded local file to the new identity instead of deleting it and downloading again.

### Unknown Artist

The artist string the indexer publishes when a file has no artist tag. It is a fallback display value, not a real artist.

## Flagged ambiguities

- "'id' in casual talk can mean either Track identity (path) or Content key (bytes) — these are distinct. A tag edit changes the content key and keeps the track identity."

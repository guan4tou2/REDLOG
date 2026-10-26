# Recording data

A logical recording keeps its recordingId, terminalId and stable castPath. Segment one uses that path; following parts use `<id>.part000002.cast`, increasing numerically. Every part has the same asciicast header clock, bounded file bytes, original frame times and valid UTF-8 frames. Logical offsets include every committed header/frame byte in that order.

Closed recording: aggregate `bytes`, aggregate SHA-256 over ordered concatenated files, `segments: [{path, bytes, sha256}]`, explicit `truncated`/`error`. A failed write never yields a successful aggregate hash. session_end carries castSegments; abrupt recovery remains interrupted with no invented close hash.

Export attachments retain each physical part's own path, prefix size, source, targets, hash/digest and exclusion. Appending after preview changes neither the approved prefix nor its bytes. Output companions remain persisted source events, ordered/deduplicated by command+sequence; no end is manufactured after interruption.

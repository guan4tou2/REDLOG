# Quickstart: Shared Event Query Language

1. Record enough activity that every Transcript bucket has more than one page.
2. Type a term that appears only in the oldest evidence and confirm it is found
   without pressing Load Older.
3. Query an event ID, a session ID and a transcript UUID for records outside the
   first page and confirm each reaches exactly that evidence.
4. Query a tool-use ID that exists in two sessions and confirm one exchange is
   shown with its session stated.
5. Query a tool-use ID whose call and result sit on different pages and confirm
   both halves appear as one block.
6. Paste a URL and confirm it is matched literally, with no condition read from
   the colon.
7. Mistype a field prefix and confirm the surface shows it was read as text.
8. Clear the query and confirm the view returns to its unqueried first page.
9. Interrupt the query path and confirm failure stays distinct from no match.

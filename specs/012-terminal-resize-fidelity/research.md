# Research: Terminal Resize Fidelity

Asciicast v2 represents a resize as `[elapsedSeconds, "r", "COLSxROWS"]`.
The frame belongs in the same newline-delimited stream as output and input
events. Existing RedLog readers intentionally select only `o` frames for text
search and command output, so recording resize frames does not pollute text.

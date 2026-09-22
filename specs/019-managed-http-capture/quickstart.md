# Quickstart: Managed HTTP Capture

1. Open a project on a machine with `mitmdump` installed.
2. Confirm HTTP capture reports running without a separate shell command.
3. Launch the REDLOG browser and visit an HTTP and HTTPS target.
4. Open a new REDLOG terminal and inspect its HTTP(S) proxy variables.
5. Stop capture; confirm a newly opened terminal receives no REDLOG proxy and
   browser launch fails clearly instead of claiming capture.
6. Close the project and confirm the owned process exits.


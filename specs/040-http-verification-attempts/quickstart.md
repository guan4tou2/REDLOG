# Manual flow
1. Start HTTP capture, choose browser and an authorized read-only HTTPS endpoint.
2. Generate and copy test URL; normal unrelated traffic must leave it waiting.
3. Open URL in configured browser. Observe response code only in browser HTTPS.
4. Select terminal, choose shell recipe, generate/copy/run in that external shell.
5. Retry before responding to an old request: old request must not pass new test.
6. Stop/restart proxy: previous results must disappear. Repeat with HTTP.
7. Fail status/config/save and verify visible retry. Narrow panel and keyboard check.

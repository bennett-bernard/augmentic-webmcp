# Computer-use form tests

Small tests for live demo contact pages using the [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents),
its built-in computer-use and web-search tools, and Playwright. Plain JavaScript, three dependencies, no build step or local web server.

## Configure your pages

Edit **scenarios/contact-forms.mjs**. Each entry defines a test name, a full live
URL, the exact accessible labels and values of its form fields, and the expected
confirmation text. Add another entry for each CPA firm's demo page.

The first scenario targets:

https://augmenticaccounting.com/webmcp-contact-me/johnsoncpa/

This page is for you to create and publish. The test does not create or host it.
Until it exists, the test will fail with a clear HTTP-status error before launching
a browser or making an OpenAI call.

For the initial scenario, build the page with this contract:

| Control | Requirement |
| --- | --- |
| Name | A text input labeled `Name`. |
| Email | An email input labeled `Email`. |
| Message | A textarea labeled `Message`. |
| Submit | A named submit button, such as `Send message`. |
| Confirmation | A visible element with `role="status"` displaying `Thanks! Your message has been received.` after submission. |

Use visible HTML labels so the agent can read the fields in screenshots and
the test can independently check their values. Match the labels and
confirmation in the scenario if you choose different wording. The pretend submit
handler should show its confirmation in the browser without sending real emails.
It may clear or hide the form afterward. Start with a single contact form per page.

## Run it

Requires Node.js **22.9+** and an OpenAI API key with API billing enabled.

```sh
npm ci
npm run browser:install
test -f .env || cp .env.example .env
# Add OPENAI_API_KEY to .env. Keep an existing .env if you already configured it.
npm test
```

On Linux, install Chromium's system libraries with
`npx playwright install-deps chromium` if needed; this may ask for your sudo password.
Chromium runs headlessly, so a VPS does not need a desktop or display.

`npm test` loads `.env` automatically; existing shell variables take precedence.
`OPENAI_MODEL` defaults to `gpt-5.4-mini`, which supports both computer use and
web search. If you still have `gpt-4.1-mini` in an existing `.env`, change it to
`gpt-5.4-mini`; the earlier model cannot perform computer use. Live agent runs
make billable API calls, including image tokens for screenshots.

Run a single URL with the first scenario's contact data and expected confirmation:

```sh
TEST_URL="https://augmenticaccounting.com/webmcp-contact-me/johnsoncpa/" npm test
```

Without `TEST_URL`, all entries in `scenarios/contact-forms.mjs` run.

```sh
npm test -- --grep "Johnson CPA"  # Run one configured page
npm test -- --headed             # Watch the browser on a machine with a desktop
npm run test:smoke                # No API calls or live website required
```

## How it works

1. Check that the configured URL responds successfully.
2. Open the URL in Chromium and give the agent a screenshot. Ask it to fill
   the form using computer use without submitting.
3. Assert that every configured field contains the correct value and that the
   success message has not already appeared.
4. Ask the agent to submit the filled form once, using the same browser page.
5. Assert that the expected confirmation is visible.

The agent has exactly two built-in tools:

| Tool | Purpose |
| --- | --- |
| `web_search` | Find/read public web information when needed. It does not operate the browser. |
| `computer` | Read screenshots and issue mouse, keyboard, scrolling, and other computer actions. |

There are no custom DOM tools. The SDK routes computer actions to a small
Playwright adapter and returns fresh screenshots to the model. Playwright's
selectors are used only by the test's independent assertions. The test sets up
the initial URL because the headless page has no browser address bar.

Each stage starts with a screenshot, allows at most 20 model turns, and aborts
after 180 seconds. The test timeout is 390 seconds, with one worker and no test
retries. The model's final answer does not determine success. The pages do not
need MCP or WebMCP support.

See the official [computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
and [GPT-5.4 mini capabilities](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

## Files and debugging

| File | Purpose |
| --- | --- |
| `scenarios/contact-forms.mjs` | Your live URLs, contact data, and expected confirmations. |
| `tests/agent.spec.mjs` | Runs the two stages and verifies the actual page state. |
| `src/browser-agent.mjs` | Agent with web search and computer use; bounded SDK run. |
| `src/playwright-computer.mjs` | Translates computer actions into mouse/keyboard input and screenshots. |
| `tests/smoke.spec.mjs` | Scripted computer calls against an intercepted page; real SDK, screenshots, and Chromium. |
| `playwright.config.mjs` | Browser settings, timeouts, and failure artifacts. |

The local to-do demo and its server have been removed. Only the offline smoke
test supplies a tiny contact form via network interception to check the tools.
It verifies coordinate clicks, typing, keyboard shortcuts, screenshot results,
and form submission. It does not verify the live model or your deployed pages.

Tool actions print in the terminal. Each completed agent stage attaches its
conversation history. Failed tests save a screenshot (when a page exists) and a
Playwright trace under `test-results/`. Open a trace on a machine with a desktop
using `npx playwright show-trace <path-to-trace.zip>`. SDK cloud trace export is
disabled. Credentials, dependencies, and test artifacts are git-ignored.

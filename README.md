# Computer-use form scenarios

Give the agent a URL and a plain-English prompt. It reads screenshots, determines
which fields correspond to your request, and fills the page using computer use.
The agent uses the [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents)
with exactly two built-in tools: `web_search` and `computer`.

## Run with your own prompt

```sh
TEST_URL='https://augmenticaccounting.com/webmcp-contact-me/johnsoncpa/' \
TEST_PROMPT='Fill out the contact form. I am Alex Taylor, alex.taylor@example.com, and I want help with bookkeeping. Do not submit.' \
npm test
```

The prompt defines the task and supplies the information to use. The agent figures
out the fields from the page. If you want it to submit, explicitly say so in the
prompt. Otherwise, it leaves the filled form for review. These scenarios are
intended for your pretend forms, whose submit handlers do not send real emails.

Either `TEST_URL` or `TEST_PROMPT` selects a single run; an omitted value comes
from the first saved scenario. Without either override, all saved scenarios run.

## Saved scenarios

Edit `scenarios/contact-forms.mjs`. Each entry contains a name, a URL, and a prompt:

```js
{
  name: 'Johnson CPA',
  url: 'https://augmenticaccounting.com/webmcp-contact-me/johnsoncpa/',
  prompt: 'Fill out the form for Alex Taylor, alex.taylor@example.com. Ask about bookkeeping services. Do not submit.',
}
```

There are no field maps, required labels, expected confirmation strings, or
separate fill/submit stages. The agent receives the prompt as written, along
with an initial screenshot of the open page.

You create and publish the live pages. Use visible labels to help the agent
understand them. An unavailable URL produces a clear HTTP-status error before
Chromium starts or an OpenAI call is made.

## Setup

Requires Node.js **22.9+**, Chromium, and an OpenAI API key with API billing enabled.

```sh
npm ci
npm run browser:install
test -f .env || cp .env.example .env
# Add OPENAI_API_KEY to .env.
npm test
```

On Linux, install Chromium's system libraries with
`npx playwright install-deps chromium` if needed; this may ask for your sudo password.
The browser is headless by default, so a VPS does not need a desktop or display.

`npm test` loads `.env`; existing shell variables take precedence.
`OPENAI_MODEL` defaults to `gpt-5.4-mini`. Choose a model supporting computer
use, such as that model or `gpt-6-astra`. The earlier `gpt-4.1-mini` default
does not support computer use. Live runs incur API charges, including screenshot
image tokens.

```sh
npm test -- --grep 'Johnson CPA'  # Run one saved scenario
npm test -- --headed             # Watch on a machine with a desktop
npm run test:smoke                # Offline check; no API key or live website needed
```

## Results

The runner opens the URL, gives the prompt and screenshot to the agent, and lets
the SDK execute its computer actions. It prints the agent's final response and
saves the prompt, conversation history, and final screenshot under `test-results/`.
Failed tests also retain a Playwright trace.

**A passing scenario is an execution check, not a grade of form correctness.**
It checks that the agent finished, returned a response, and requested form
interaction. Review the screenshot and transcript to judge whether it filled the
page correctly. Prompt-only scenarios have no fixed field-by-field assertions;
partial completion may still require your review.

The agent can take at most 20 model turns and runs for at most 180 seconds. The
test timeout is 240 seconds, with one worker and no test retries. SDK cloud trace
export is disabled; local artifacts and credentials are git-ignored.

## Files

| File | Purpose |
| --- | --- |
| `scenarios/contact-forms.mjs` | Saved URLs and plain-English prompts. |
| `tests/agent.spec.mjs` | Runs the prompt and saves results for review. |
| `src/browser-agent.mjs` | Agent with web search and computer use. |
| `src/playwright-computer.mjs` | Executes mouse/keyboard actions and captures screenshots. |
| `tests/smoke.spec.mjs` | Tests the SDK and computer adapter against an intercepted fake form. |
| `playwright.config.mjs` | Browser settings, timeouts, and failure artifacts. |

Web search can find public information; it does not operate the browser. The
computer tool reads screenshots and sends mouse/keyboard actions. There are no
custom DOM tools or model-facing selectors. The pages need no MCP or WebMCP support.

The offline smoke test still checks exact values on its own tiny fixture to
verify the computer adapter. Those checks do not constrain your live scenarios.

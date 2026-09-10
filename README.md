# Computer-use form scenarios

Give the agent a URL and a plain-English prompt. GPT-6 Astra writes Playwright
JavaScript to inspect and operate the form, using screenshots to check its work.
This follows the [official OpenAI code-execution recommendation](https://developers.openai.com/api/docs/guides/tools-computer-use#use-code-execution).

The OpenAI Agents SDK manages the conversation and two tools: `web_search` and
`exec_js`. Each scenario gets a disposable Docker container containing Chromium
and a persistent JavaScript runtime. The API key stays in the host process.

## Run with your own prompt

```sh
TEST_URL='https://augmenticaccounting.com/johnsoncpa/contact-me/' \
TEST_PROMPT='Fill out the contact form. I am Alex Taylor, alex.taylor@example.com, and I want help with bookkeeping. Do not submit.' \
npm test
```

The prompt defines the task and supplies the information to use. The agent figures
out the fields from the page. If you want it to submit, explicitly say so in the
prompt. Otherwise, it leaves the form unsubmitted and saves a screenshot before
discarding the browser. These scenarios are intended for your pretend forms,
whose submit handlers do not send real emails.

Either `TEST_URL` or `TEST_PROMPT` selects a single run; an omitted value comes
from the first saved scenario. Without either override, all saved scenarios run.

## Saved scenarios

Edit `scenarios/contact-forms.mjs`. Each entry contains a name, a URL, and a prompt:

```js
{
  name: 'Johnson CPA',
  url: 'https://augmenticaccounting.com/johnsoncpa/contact-me/',
  prompt: 'Fill out the form for Alex Taylor, alex.taylor@example.com. Ask about bookkeeping services. Do not submit.',
}
```

There are no field maps, required labels, expected confirmation strings, or
separate fill/submit stages. The agent receives the prompt as written, along
with an initial screenshot of the open page. It can use Playwright locators,
read the DOM, or use mouse and keyboard actions to operate the visible UI.

You create and publish the live pages. An unavailable URL produces an HTTP-status
error before the browser container starts or an OpenAI call is made.

## Setup

Requires Node.js **22.9+**, a running Docker daemon, and an OpenAI API key with
API billing enabled. Docker supplies Chromium and its system libraries; no host
browser installation or desktop is needed.

```sh
npm ci
npm run sandbox:build
test -f .env || cp .env.example .env
# Add OPENAI_API_KEY to .env and set OPENAI_MODEL=gpt-6-astra.
npm run test:smoke
npm test
```

`npm test` loads `.env`; existing shell variables take precedence.
`OPENAI_MODEL` defaults to `gpt-6-astra`. If you already have a `.env` file, update
its old model setting to `gpt-6-astra` or remove the setting to use the default.
Live runs incur API charges, including screenshot image tokens.

Rebuild with `npm run sandbox:build` after changing the sandbox worker or package
lockfile. The container uses Playwright **1.63.0**, matching `package.json`.

```sh
npm test -- --grep 'Johnson CPA'  # Run one saved scenario
npm run test:smoke                # Offline checks; no API key or live website needed
```

The runtime is headless. Use the saved screenshots and failure traces to inspect
runs; `--headed` is not supported by the container fixture.

## Code execution

`exec_js` accepts `{ code: "...JavaScript..." }`. It provides Playwright's
`browser`, `context`, and `page`, plus `Buffer`, `console.log()`, and `display()`.
Scripts support top-level `await`. Save reusable variables on `globalThis` to
keep them across calls; browser state also persists throughout a scenario.

```js
globalThis.emailField = page.getByRole('textbox', { name: 'Email' });
await emailField.fill('alex.taylor@example.com');
console.log(await emailField.inputValue());
display(await page.screenshot());
```

Text and PNG images are returned as structured function-tool results. Every
script also returns a screenshot of its final UI state with original image
detail. Script errors return an error message and screenshot so the agent can
correct its next call. Web search discovers public information separately.
Pages need no MCP or WebMCP support.

Generated code runs as an unprivileged user in a container with a read-only root
filesystem, temporary storage, and resource limits. No host folders, Docker
socket, or host credentials are mounted or passed into the container. Live runs
have Docker bridge networking to reach websites; smoke tests disable networking.
Docker is the isolation boundary. The worker's `node:vm` context only preserves
JavaScript state and is not a security sandbox.

## Results and limits

The runner prints the agent's final response and saves the prompt, conversation
history, executed scripts with their observations, and final screenshot under
`test-results/`. Failures also capture a browser trace when the runtime remains
available. A timeout or cancellation destroys the container immediately, so
only observations already received are available in those cases.

**A passing scenario is an execution check, not a grade of form correctness.**
It verifies that the agent finished, returned a response, and successfully
executed browser code. A read-only script can satisfy that execution check.
Review the screenshots and transcript to judge the actual task result.

Each script has a 15-second wall-clock limit; timeout and cancellation stop the
whole container, including code stuck after an `await`. The agent can take at
most 20 model turns and runs for at most 180 seconds. The test timeout is 240
seconds, with one worker and no retries. Containers are removed after each test.
SDK cloud trace export is disabled; local artifacts and credentials are ignored
by Git and excluded from the Docker build context.

## Files

| File | Purpose |
| --- | --- |
| `scenarios/contact-forms.mjs` | Saved URLs and plain-English prompts. |
| `src/browser-agent.mjs` | Astra agent with web search and JavaScript execution. |
| `src/browser-runtime.mjs` | Container lifecycle, command transport, and execution deadlines. |
| `src/sandbox-worker.mjs` | Persistent Playwright runtime and text/image observations. |
| `sandbox/Dockerfile` | Isolated browser image. |
| `tests/fixtures.mjs` | Per-test runtime and failure artifacts. |
| `tests/agent.spec.mjs` | Live prompt scenarios and execution checks. |
| `tests/smoke.spec.mjs` | Offline SDK, form interaction, isolation, and cancellation checks. |
| `playwright.config.mjs` | Test timeout and viewport. |

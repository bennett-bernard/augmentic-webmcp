import { test, expect, saveArtifact } from './fixtures.mjs';
import { runBrowserTask } from '../src/browser-agent.mjs';
import { contactForms } from '../scenarios/contact-forms.mjs';

// Either override runs one scenario, reusing the first scenario's other settings.
const targetURL = process.env.TEST_URL?.trim();
const prompt = process.env.TEST_PROMPT?.trim();
const requiredWebMCPTool = process.env.TEST_REQUIRE_WEBMCP_TOOL?.trim();
const scenarios = targetURL || prompt
  ? [{ ...contactForms[0], name: 'Custom scenario',
    url: targetURL || contactForms[0].url,
    prompt: prompt || contactForms[0].prompt }]
  : contactForms;

for (const scenario of scenarios) {
  test.describe(scenario.name, () => {
    // Check availability before starting Chromium or making an OpenAI call.
    test.beforeAll(async ({ request }) => {
      expect(scenario.prompt?.trim(), 'A scenario needs a non-empty prompt.').toBeTruthy();
      const response = await request.get(scenario.url, { timeout: 20_000 });
      expect(response.ok(),
        'Page returned HTTP ' + response.status() + ': ' + scenario.url +
        '. Publish the page or update TEST_URL / scenarios/contact-forms.mjs.',
      ).toBeTruthy();
    });

    test('agent follows the form prompt', async ({ runtime }, testInfo) => {
      await saveArtifact(testInfo, 'scenario', {
        body: JSON.stringify({ url: scenario.url, prompt: scenario.prompt }, null, 2),
        contentType: 'application/json',
      });
      await runtime.open(scenario.url);
      const started = performance.now();
      let result;
      try {
        result = await runBrowserTask(runtime, scenario.prompt, {
          requiredWebMCPTool, structuredWebMCP: process.env.TEST_WEBMCP_STRUCTURED === '1',
        });
      } finally {
        await saveArtifact(testInfo, 'run-metrics', {
          body: JSON.stringify({
            agentDurationMs: Math.round(performance.now() - started),
            model: process.env.OPENAI_MODEL?.trim() || 'gpt-6-astra',
            modelResponses: result?.rawResponses.length ?? null,
            usage: result?.state.usage ?? null,
            finalOutput: result?.finalOutput ?? null,
            observationMode: runtime.structuredObservations ? 'structured' : 'screenshots',
            imageObservations: runtime.initialImageCount + runtime.history.reduce((count, entry) =>
              count + (entry.output?.filter(item => item.type === 'image').length ?? 0), 0),
            visualVerifications: runtime.history.filter(entry => entry.type === 'verify_page' && !entry.error).length,
          }, null, 2), contentType: 'application/json',
        });
      }
      await saveArtifact(testInfo, 'agent-history', {
        body: JSON.stringify(result.history, null, 2),
        contentType: 'application/json',
      });
      await saveArtifact(testInfo, 'final-page', {
        body: await runtime.screenshot(true),
        contentType: 'image/png',
      });
      console.log('Agent:', result.finalOutput);
      const nativeCalls = runtime.history.filter(entry => entry.type === 'webmcp' && !entry.error);
      console.log('WebMCP:', runtime.webmcp.status, '| exposed:', runtime.webmcp.tools.map(tool => tool.name).join(', ') || 'none', '| successful calls:', nativeCalls.map(entry => entry.name).join(', ') || 'none');
      console.log('Review artifacts:', testInfo.outputDir);

      // Execution checks only. Review the screenshot/transcript for task correctness.
      expect(result.interruptions, 'The agent run paused before finishing.').toHaveLength(0);
      expect(result.finalOutput, 'The agent did not return a final response.').toBeTruthy();
      expect(runtime.history.some((entry) => !entry.error && entry.output?.length),
        'The agent finished without successfully executing browser code or a WebMCP tool.',
      ).toBe(true);
      if (requiredWebMCPTool) {
        expect(nativeCalls.map(entry => entry.name), 'The required WebMCP tool was exposed but never successfully called.').toContain(requiredWebMCPTool);
      }
      if (runtime.structuredObservations) {
        expect(runtime.history.filter(entry => !entry.error).at(-1)?.type,
          'Structured WebMCP runs must finish with a visual verification.',
        ).toBe('verify_page');
      }
    });
  });
}

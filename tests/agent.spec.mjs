import { test, expect } from '@playwright/test';
import { runBrowserTask } from '../src/browser-agent.mjs';
import { contactForms } from '../scenarios/contact-forms.mjs';

// A URL override runs one test using the first scenario's data and assertions.
const targetURL = process.env.TEST_URL?.trim();
const scenarios = targetURL
  ? [{ ...contactForms[0], name: 'Custom URL: ' + targetURL, url: targetURL }]
  : contactForms;

for (const scenario of scenarios) {
  test.describe(scenario.name, () => {
    // Check availability before starting Chromium or making an OpenAI call.
    test.beforeAll(async ({ request }) => {
      const response = await request.get(scenario.url, { timeout: 20_000 });
      expect(response.ok(),
        'Demo page returned HTTP ' + response.status() + ': ' + scenario.url +
        '. Publish the page or update scenarios/contact-forms.mjs.',
      ).toBeTruthy();
    });

    test('agent fills and submits the contact form', async ({ page }, testInfo) => {
      // Navigation is test setup; the agent receives the page as a screenshot.
      await page.goto(scenario.url);
      const filled = await runBrowserTask(page,
        'The page at ' + scenario.url + ' is open. Fill the contact form with these details: ' +
        JSON.stringify(scenario.fields) + '. Leave the form filled. Do not submit yet.',
      );
      await testInfo.attach('fill-history', {
        body: JSON.stringify(filled.history, null, 2),
        contentType: 'application/json',
      });

      // Check the actual inputs before submission can clear or hide them.
      await expect(page).toHaveURL(scenario.url);
      for (const [name, value] of Object.entries(scenario.fields)) {
        await expect(page.getByRole('textbox', { name, exact: true })).toHaveValue(value);
      }
      await expect(page.getByRole('status')).not.toHaveText(scenario.successText);

      const submitted = await runBrowserTask(page,
        'Use the contact form on the page that is already open. Do not navigate or ' +
        'change any fields. Submit this pretend inquiry exactly once and wait for ' +
        'the on-page confirmation.',
      );
      await testInfo.attach('submit-history', {
        body: JSON.stringify(submitted.history, null, 2),
        contentType: 'application/json',
      });
      console.log('Agent:', submitted.finalOutput);

      // The agent saying it succeeded is not enough; the page must confirm it.
      await expect(page.getByRole('status')).toBeVisible();
      await expect(page.getByRole('status')).toHaveText(scenario.successText);
    });
  });
}

import { test as base, expect } from '@playwright/test';
import { BrowserRuntime } from '../src/browser-runtime.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

export { expect };

// Body-only attachments live in the reporter's memory. Persist them explicitly
// so the list reporter also leaves reviewable files after a successful run.
export async function saveArtifact(testInfo, name, { body, contentType }) {
  const extension = {
    'application/json': 'json', 'image/png': 'png', 'application/zip': 'zip',
  }[contentType];
  const path = testInfo.outputPath(name + '.' + extension);
  await mkdir(testInfo.outputDir, { recursive: true });
  await writeFile(path, body);
  await testInfo.attach(name, { path, contentType });
}

export const test = base.extend({
  runtimeOffline: [false, { option: true }],
  runtime: async ({ viewport, headless, runtimeOffline }, use, testInfo) => {
    if (!headless) throw new Error('The isolated browser is headless. Review the saved screenshots and trace.');
    const runtime = new BrowserRuntime({ viewport, offline: runtimeOffline });
    await runtime.start();
    try {
      await use(runtime);
    } finally {
      try {
        await saveArtifact(testInfo, 'execution-history', {
          body: JSON.stringify(runtime.history, null, 2), contentType: 'application/json',
        });
        if (testInfo.status !== testInfo.expectedStatus && !runtime.failure) {
          await saveArtifact(testInfo, 'failure-page', {
            body: await runtime.screenshot(true), contentType: 'image/png',
          });
          await saveArtifact(testInfo, 'browser-trace', {
            body: await runtime.trace(), contentType: 'application/zip',
          });
        }
      } finally {
        await runtime.close();
      }
    }
  },
});

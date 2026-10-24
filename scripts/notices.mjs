// Writes THIRD_PARTY_NOTICES.md: the licenses of the code esbuild bundles into the app (npm run notices).
import { readFileSync, writeFileSync } from 'node:fs';

// Bundled into dist/renderer/app.js. The Agent SDK and zod stay in node_modules (installed, not bundled).
const BUNDLED = ['three', 'marked', 'dompurify'];
const VSCODE_MIT = `MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const sections = BUNDLED.map((name) => {
  const pkg = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8'));
  const license = readFileSync(`node_modules/${name}/LICENSE`, 'utf8').trim();
  return `## ${name} ${pkg.version} (${pkg.license})\n\n${pkg.homepage ?? ''}\n\n\`\`\`\n${license}\n\`\`\``;
});
sections.push(`## Visual Studio Code: Source Control Graph (MIT)\n\nPorted in src/renderer/graph.ts from https://github.com/microsoft/vscode\n\n\`\`\`\n${VSCODE_MIT}\n\`\`\``);

writeFileSync(
  'THIRD_PARTY_NOTICES.md',
  `# Third-party notices\n\nThe app bundles the following open-source code. Electron ships its own notices (LICENSES.chromium.html) in every build.\n\n${sections.join('\n\n')}\n`,
);
console.log('THIRD_PARTY_NOTICES.md written');

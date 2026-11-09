import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localReason, mcpServersOf } from './placement';

const post = (o: Partial<{ name: string; description: string; instructions: string; folders: string[] }> = {}) => ({
  name: 'site',
  description: 'Le site perso, de bout en bout.',
  instructions: '',
  folders: ['C:\\repos\\site'],
  ...o,
});

test('a post that drives Blender or Unity stays on this PC, whatever the case or the wording', () => {
  assert.deepEqual(localReason(post({ name: 'blender-3d' }), []), { kind: 'app', name: 'blender' });
  assert.deepEqual(localReason(post({ description: 'Jeux et projets Unity de bout en bout' }), []), { kind: 'app', name: 'unity' });
  assert.deepEqual(localReason(post({ instructions: 'Pilote le navigateur avec Claude in Chrome.' }), []), { kind: 'app', name: 'claude in chrome' });
  assert.deepEqual(localReason(post({ instructions: 'uses computer use' }), []), { kind: 'app', name: 'computer-use' });
  // A word that only contains the name is not the program.
  assert.equal(localReason(post({ description: 'community and unityped words' }), []), null);
});

test("a post whose folders declare a local MCP server stays on this PC, even inside a server's name", () => {
  assert.deepEqual(localReason(post(), ['unityMCP', 'uvx mcp-for-unity']), { kind: 'mcp', name: 'unity' });
  assert.deepEqual(localReason(post(), ['browser', 'npx @playwright/mcp@latest']), { kind: 'mcp', name: 'playwright' });
  assert.equal(localReason(post(), ['supabase', 'https://mcp.supabase.com/mcp']), null);
});

test('a post with other folders than its repo stays on this PC: the server has no copy of them', () => {
  assert.deepEqual(localReason(post({ folders: ['C:\\repos\\site', 'C:\\Users\\me\\Documents'] }), []), { kind: 'folders' });
  assert.equal(localReason(post(), []), null);
});

test('the servers of an .mcp.json are read by name and command, anything else gives none', () => {
  const json = { mcpServers: { unityMCP: { command: 'uvx', args: ['mcp-for-unity'] }, remote: { type: 'http', url: 'https://x.example/mcp' } } };
  assert.deepEqual(mcpServersOf(json), ['unityMCP', 'uvx mcp-for-unity', 'remote', 'https://x.example/mcp']);
  assert.deepEqual(mcpServersOf(null), []);
  assert.deepEqual(mcpServersOf({ mcpServers: 'x' }), []);
  assert.deepEqual(mcpServersOf([1, 2]), []);
});

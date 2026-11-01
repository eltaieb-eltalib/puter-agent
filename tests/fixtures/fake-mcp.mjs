// A tiny MCP server for tests: tools "echo" and "boom".
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  ] } });
  else if (m.method === 'tools/call') {
    if (m.params.name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo: ${m.params.arguments.text}` }] } });
    else send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'it broke' }] } });
  }
});

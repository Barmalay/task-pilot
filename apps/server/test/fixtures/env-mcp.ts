/**
 * MCP-сервер для тестов McpHub: инструмент env отвечает значением переменной окружения, с которой сервер запущен.
 * По нему видно, с каким доступом открыто подключение.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'env', version: '0.1.0' });
server.registerTool('env', { description: 'Значение переменной окружения', inputSchema: { name: z.string() } }, async ({ name }) => ({
  content: [{ type: 'text' as const, text: process.env[name] ?? '' }],
}));
await server.connect(new StdioServerTransport());

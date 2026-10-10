import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server';

// stdout carries the protocol, so nothing else may print there.
await createServer().connect(new StdioServerTransport());

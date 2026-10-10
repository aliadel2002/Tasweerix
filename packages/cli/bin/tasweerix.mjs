#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so the monorepo needs no build step.
import { register } from 'tsx/esm/api';
register();
await import('../src/main.ts');

// Lets Node load the server code by standing in for Cloudflare's built-in "cloudflare:sockets" module.
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:sockets') return { url: 'data:text/javascript,export function connect(){throw new Error("no sockets in tests")}', shortCircuit: true };
  return next(spec, ctx);
}`));

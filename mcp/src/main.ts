import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createHttpApp } from './app';
import { createServer } from './server';

/*
 * `--stdio` for an agent that starts the server itself (Claude Code, Claude
 * Desktop, Cursor, VS Code). Without it, Streamable HTTP on /mcp.
 */

function serveHttp(): void {
  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  // Loopback by default, which also turns on the SDK's DNS rebinding
  // protection. A hosted deployment sets HOST=0.0.0.0 and sits behind TLS.
  const host = process.env.HOST ?? '127.0.0.1';
  // A tunnel (cloudflared, ngrok) arrives on loopback carrying its own
  // hostname, which the localhost check refuses. ALLOWED_HOSTS names it,
  // keeping the check on rather than binding wide open to get past it.
  const extra = (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const app = createHttpApp({
    host,
    ...(extra.length > 0 ? { allowedHosts: ['localhost', '127.0.0.1', ...extra] } : {}),
  });

  app.listen(port, host, (err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Archisys MCP on http://localhost:${port}/mcp`);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--stdio')) {
    await createServer().connect(new StdioServerTransport());
  } else {
    serveHttp();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

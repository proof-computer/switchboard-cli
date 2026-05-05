import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderDemoPage } from "../src/jobs/express-demo-page.js";

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? "127.0.0.1";
const port = Number(args.port ?? process.env.PORT ?? "8787");
const fixturePath = path.resolve(args.fixture ?? "tests/fixtures/express-webserver-live-status.json");

let status = await readStatusFixture();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderDemoPage(status));
      return;
    }
    if (url.pathname === "/status") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    if (url.pathname === "/__reload") {
      status = await readStatusFixture();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify({ ok: true, fixture: fixturePath })}\n`);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
});

server.listen(port, host, () => {
  console.log(`Switchboard express demo preview: http://${host}:${port}/`);
  console.log(`Fixture: ${fixturePath}`);
  console.log("Reload fixture without restart: http://" + host + ":" + port + "/__reload");
});

async function readStatusFixture(): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Fixture must be a JSON object: ${fixturePath}`);
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(values: string[]): { host?: string; port?: string; fixture?: string } {
  const parsed: { host?: string; port?: string; fixture?: string } = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") {
      continue;
    }
    if (value === "--host") {
      parsed.host = requiredArg(values[++index], value);
    } else if (value === "--port") {
      parsed.port = requiredArg(values[++index], value);
    } else if (value === "--fixture") {
      parsed.fixture = requiredArg(values[++index], value);
    } else if (value === "--help" || value === "-h") {
      console.log("Usage: pnpm preview:express-demo [--port 8787] [--fixture tests/fixtures/express-webserver-live-status.json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function requiredArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

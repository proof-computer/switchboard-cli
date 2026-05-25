import {
  boolFlag,
  pruneUndefined,
  readContextStore,
  sanitizeContextForOutput,
  stringFlag,
  writeContextStore,
  writeOutput,
  type CliRuntime,
  type SwitchboardContext
} from "../index.js";

const SUPPORTED_PROVIDERS = new Set(["cloudflare"]);

export async function contextDnsSetCommand(
  flags: Map<string, string | boolean>,
  positionals: string[],
  runtime?: Pick<CliRuntime, "contextStorePath">
): Promise<void> {
  const provider = positionals[3];
  if (!provider) {
    throw new Error(
      "Missing DNS provider. PROOF DNS authority is a support/admin path; if instructed, use `switchboard context dns set cloudflare --token-env <NAME>`."
    );
  }
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported DNS provider "${provider}". Supported: ${[...SUPPORTED_PROVIDERS].join(", ")}`);
  }

  const tokenEnv = stringFlag(flags, "token-env");
  if (!tokenEnv) {
    throw new Error("Missing --token-env <NAME> (env var holding the provider API token).");
  }

  const explicitContext = stringFlag(flags, "context");
  const contextStorePath = runtime?.contextStorePath;
  const store = contextStorePath ? await readContextStore(contextStorePath) : await readContextStore();
  const targetName = explicitContext ?? store.current;
  if (!targetName) {
    throw new Error("No context selected. Pass --context <name> or run `switchboard context use <name>` first.");
  }
  const existing: SwitchboardContext = store.contexts?.[targetName] ?? {};

  const next: SwitchboardContext = { ...existing };
  if (provider === "cloudflare") {
    next.cloudflareApiTokenEnv = tokenEnv;
  }
  pruneUndefined(next);

  store.contexts = { ...(store.contexts ?? {}), [targetName]: next };
  if (contextStorePath) {
    await writeContextStore(store, contextStorePath);
  } else {
    await writeContextStore(store);
  }

  writeOutput(
    flags,
    {
      ok: true,
      action: "context-dns-set",
      provider,
      context: targetName,
      tokenEnv,
      sanitized: sanitizeContextForOutput(next)
    },
    () => {
      console.log(`DNS provider ${provider} attached to context ${targetName} (${tokenEnv}).`);
      if (boolFlag(flags, "verbose")) {
        console.log("Stored env var:", tokenEnv);
      }
    }
  );
}

export async function contextDnsClearCommand(
  flags: Map<string, string | boolean>,
  positionals: string[],
  runtime?: Pick<CliRuntime, "contextStorePath">
): Promise<void> {
  const provider = positionals[3] ?? "cloudflare";
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported DNS provider "${provider}".`);
  }
  const explicitContext = stringFlag(flags, "context");
  const contextStorePath = runtime?.contextStorePath;
  const store = contextStorePath ? await readContextStore(contextStorePath) : await readContextStore();
  const targetName = explicitContext ?? store.current;
  if (!targetName || !store.contexts?.[targetName]) {
    throw new Error("No matching context.");
  }
  const next: SwitchboardContext = { ...store.contexts[targetName] };
  if (provider === "cloudflare") {
    delete next.cloudflareApiTokenEnv;
  }
  store.contexts[targetName] = next;
  if (contextStorePath) {
    await writeContextStore(store, contextStorePath);
  } else {
    await writeContextStore(store);
  }

  writeOutput(
    flags,
    { ok: true, action: "context-dns-clear", provider, context: targetName, sanitized: sanitizeContextForOutput(next) },
    () => {
      console.log(`Cleared ${provider} DNS provider from context ${targetName}.`);
    }
  );
}

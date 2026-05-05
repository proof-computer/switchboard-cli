interface HtmlFragment {
  __html: string;
}

interface DeploymentInfo {
  raw: string;
  id?: string;
  kind?: string;
}

export function renderDemoPage(status: Record<string, any>): string {
  const publicUrl = stringValue(status.public?.url);
  const publicHostname = stringValue(status.public?.hostname);
  const publicLabel = publicHostname ? shortHostname(publicHostname) : publicUrl;
  const challengeUrl = stringValue(status.public?.challengeUrl);
  const certificate = primaryCertificate(status);
  const registration = status.registration;
  const relayHealth = status.relayDiagnostics?.health;
  const relayDns = status.relayDiagnostics?.dns;
  const deployment = deploymentInfo(status.ids?.deploymentId);
  const deploymentLink = deploymentHtml(deployment);
  const gatewayId = knownGatewayId(status);
  const jobEndAt = knownJobEndAt(status);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Switchboard demo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: light;
      --beacon: #ff6a2c;
      --beacon-2: #e5571b;
      --ink: #0e1218;
      --ink-soft: #1a2030;
      --frost: #f7f8fa;
      --hull: #1a2538;
      --tide: #0e7cff;
      --smoke: #e7eaee;
      --stone: #9098a6;
      --steel: #3d4654;
      --acurast-green: #c0e700;
      --panel: #ffffff;
      --ok: #0f7b49;
      --ok-bg: #e7f6ed;
      --warn: #936200;
      --warn-bg: #fff3cf;
      --info: var(--tide);
      --info-bg: #e8f1ff;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--frost);
      color: var(--ink);
      font-size: 15px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    a {
      color: var(--ink);
      text-decoration-color: var(--beacon);
      text-decoration-thickness: 2px;
      text-underline-offset: 4px;
      overflow-wrap: anywhere;
    }
    a:hover { text-decoration-color: var(--ink); }
    .shell {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 44px;
    }
    .brand-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 0 18px;
      border-bottom: 1px solid var(--smoke);
      color: var(--ink);
    }
    .proof-mark {
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
    }
    .proof-wordmark {
      font-family: "Space Grotesk", Inter, sans-serif;
      font-size: 20px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: 0;
    }
    .proof-wordmark .dot {
      color: var(--beacon);
    }
    .brand-spacer { flex: 1; }
    .brand-doc-tag {
      color: var(--stone);
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 11px;
      line-height: 1;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 28px;
      align-items: start;
      margin: 22px 0 18px;
      padding: 84px 48px 78px;
      background: var(--hull);
      color: var(--frost);
      border-radius: 8px;
      overflow: hidden;
      position: relative;
    }
    header::after {
      position: absolute;
      content: "";
      inset: 0;
      background: linear-gradient(90deg, rgba(26, 37, 56, 0) 0%, rgba(26, 37, 56, 0.04) 62%, rgba(26, 37, 56, 0.38) 100%);
      pointer-events: none;
      z-index: 1;
    }
    .hero-cable {
      position: absolute;
      top: -82px;
      right: -184px;
      width: 520px;
      height: 340px;
      opacity: 1;
      pointer-events: none;
      z-index: 0;
    }
    .header-copy {
      position: relative;
      z-index: 2;
    }
    h1 {
      max-width: 880px;
      margin: 0;
      font-family: "Space Grotesk", Inter, sans-serif;
      font-size: 92px;
      line-height: 0.92;
      font-weight: 700;
      letter-spacing: 0;
    }
    .accent { color: var(--beacon); }
    .acurast-accent { color: var(--acurast-green); }
    .metric, article, .diagnostics {
      border: 1px solid var(--smoke);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 1px 0 rgba(14, 18, 24, 0.03);
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin: 18px 0;
    }
    .metric {
      padding: 14px 16px;
      min-width: 0;
    }
    .label {
      display: block;
      color: var(--stone);
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .value {
      display: block;
      margin-top: 5px;
      font-size: 16px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .value-secondary {
      display: block;
      margin-top: 3px;
      color: var(--steel);
      font-size: 13px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    article {
      min-width: 0;
      overflow: hidden;
    }
    h2 {
      margin: 0;
      padding: 13px 16px;
      border-bottom: 1px solid var(--smoke);
      font-family: "Space Grotesk", Inter, sans-serif;
      font-size: 15px;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 10px 16px;
      vertical-align: top;
      border-bottom: 1px solid #edf0f4;
      overflow-wrap: anywhere;
    }
    th {
      width: 34%;
      color: var(--stone);
      text-align: left;
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    td { font-size: 14px; font-weight: 560; }
    tr:last-child th, tr:last-child td { border-bottom: 0; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.4 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      color: var(--ink-soft);
    }
    code {
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
    }
    .mono {
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
    }
    .muted { color: var(--stone); font-weight: 520; }
    .full { grid-column: 1 / -1; }
    .diagnostics {
      margin-top: 12px;
      overflow: hidden;
    }
    .diagnostics summary {
      cursor: pointer;
      padding: 13px 16px;
      font-family: "Space Grotesk", Inter, sans-serif;
      font-weight: 700;
    }
    .diagnostics table { border-top: 1px solid var(--smoke); }
    @media (max-width: 1040px) {
      h1 { font-size: 72px; }
    }
    @media (max-width: 820px) {
      .shell { width: min(100vw - 20px, 1180px); padding-top: 16px; }
      .brand-bar { align-items: flex-start; }
      .brand-doc-tag { display: none; }
      header {
        grid-template-columns: 1fr;
        padding: 58px 18px 54px;
      }
      header::after {
        background: linear-gradient(90deg, rgba(26, 37, 56, 0) 0%, rgba(26, 37, 56, 0.08) 78%, rgba(26, 37, 56, 0.4) 100%);
      }
      .hero-cable {
        top: -38px;
        right: -286px;
        width: 430px;
        height: 260px;
        opacity: 0.92;
      }
      .summary, .grid { grid-template-columns: 1fr; }
      h1 {
        font-size: 40px;
        line-height: 0.98;
      }
      .acurast-accent { display: block; }
      th, td { display: block; width: 100%; }
      th { padding-bottom: 2px; border-bottom: 0; }
      td { padding-top: 2px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="brand-bar">
      <svg class="proof-mark" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="48" fill="#ff6a2c"/>
      </svg>
      <span class="proof-wordmark">PROOF<span class="dot">.</span></span>
      <span class="brand-spacer"></span>
      <span class="brand-doc-tag">Switchboard · Acurast webserver</span>
    </div>

    <header>
      <svg class="hero-cable" viewBox="0 0 720 480" aria-hidden="true">
        <path d="M 60 380 Q 360 -120, 660 380" stroke="#ff6a2c" stroke-width="36" stroke-linecap="round" fill="none"/>
        <circle cx="60" cy="380" r="56" fill="#ff6a2c"/>
        <circle cx="660" cy="380" r="56" fill="#ff6a2c"/>
      </svg>
      <div class="header-copy">
        <h1>Running on <span class="acurast-accent">Acurast,</span> ingress by <span class="accent">Switchboard</span></h1>
      </div>
    </header>

    <section class="summary">
      ${metricHtml("TLS Certificate", certificate?.issuer ?? status.certificate?.state, certificate?.notAfter ? `expires ${formatDateTime(certificate.notAfter)}` : undefined)}
      ${metricHtml("Hub Registration", registration?.relayResponse?.txHash ? shortValue(registration.relayResponse.txHash) : registration?.state, blockSecondaryHtml(registration?.relayResponse?.blockNumber))}
      ${metricHtml("Acurast Runtime", runtimeLabel(status), deploymentLink)}
    </section>

    <section class="grid">
      <article>
        <h2>Route</h2>
        ${tableHtml([
          ["Endpoint", publicUrl ? linkHtml(publicUrl, publicLabel ?? publicUrl, publicUrl) : undefined],
          ["Challenge", challengeUrl ? linkHtml(challengeUrl, "/.well-known/proofcomputer/challenge", challengeUrl) : undefined],
          ["Relay", status.routing?.relayUrl ? linkHtml(status.routing.relayUrl, status.routing?.relayHost ?? status.routing.relayUrl, status.routing.relayUrl) : undefined],
          ...optionalRow("Gateway ID", gatewayId),
          ["Relay DNS", relayDns?.ok ? formatAddressList(relayDns.addresses) : relayDns?.error],
          ["Relay health", relayHealth?.ok ? `HTTP ${relayHealth.status} in ${relayHealth.elapsedMs}ms` : relayHealth?.error]
        ])}
      </article>

      <article>
        <h2>Acurast Job</h2>
        ${tableHtml([
          ["Deployment", deploymentLink],
          ["Job", hashHtml(status.ids?.jobId)],
          ["Job signer", hashHtml(status.ids?.jobSigner)],
          ["Signer mode", status.ids?.signerMode],
          ["Runtime", runtimeLabel(status)],
          ["Started", formatDateTime(status.startedAt)],
          ...optionalRow("Job ends", jobEndAt),
          ["Uptime", formatDuration(Number(status.uptimeSeconds ?? 0))]
        ])}
      </article>

      <article>
        <h2>Polkadot Hub</h2>
        ${tableHtml([
          ["Chain ID", status.routing?.chainId],
          ["Registry", hashHtml(status.routing?.registryAddress)],
          ["Session", hashHtml(status.ids?.sessionId)],
          ["Registration", status.registration?.state],
          ["Tx", hashHtml(status.registration?.relayResponse?.txHash)],
          ["Block", assetHubBlockHtml(status.registration?.relayResponse?.blockNumber)]
        ])}
      </article>

      <article>
        <h2>Certificate</h2>
        ${tableHtml([
          ["State", status.certificate?.state],
          ["Hostname", certificate?.hostname ?? status.certificate?.hostname],
          ["Issuer", certificate?.issuer],
          ["Issued", formatDateTime(status.certificate?.issuedAt)],
          ["Expires", formatDateTime(certificate?.notAfter)],
          ["Hostnames", status.certificate?.hostnames]
        ])}
      </article>

      <article>
        <h2>Challenges</h2>
        ${tableHtml([
          ["Count", status.challenges?.count],
          ["Last at", formatDateTime(status.challenges?.lastAt)],
          ["Nonce length", status.challenges?.last?.nonceLength],
          ["User agent", status.challenges?.last?.userAgent],
          ["Remote address", status.challenges?.last?.remoteAddress]
        ])}
      </article>

      <article>
        <h2>Runtime Details</h2>
        ${tableHtml([
          ["Node", status.runtime?.nodeVersion],
          ["Platform", `${status.runtime?.platform ?? "unknown"} ${status.runtime?.arch ?? ""}`.trim()],
          ["Acurast STD", boolLabel(status.runtime?.hasStd)],
          ["Secp256k1 signer", boolLabel(status.runtime?.hasStdSignersSecp256k1)],
          ["Network allowlist", boolLabel(status.runtime?.hasStdNetAddAllowedHostnames)],
          ["App version", status.runtime?.appVersion]
        ])}
      </article>
    </section>

    <details class="diagnostics">
      <summary>Diagnostic Data</summary>
      ${tableHtml([
        ["Registration", status.registration],
        ["Certificate", status.certificate],
        ["Relay diagnostics", status.relayDiagnostics],
        ["Network", status.network],
        ["Environment presence", status.envPresence]
      ])}
    </details>
  </div>
</body>
</html>`;
}

function metricHtml(label: string, value: unknown, secondary?: unknown): string {
  const secondaryHtml = secondary === undefined || secondary === null || secondary === "" ? "" : `<span class="value-secondary">${renderValue(secondary)}</span>`;
  return `<div class="metric"><span class="label">${escapeHtml(label)}</span><span class="value">${renderValue(value)}</span>${secondaryHtml}</div>`;
}

function tableHtml(rows: Array<[string, unknown]>): string {
  return `<table><tbody>${rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${renderValue(value)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function linkHtml(href: string, label: string, title = href): HtmlFragment {
  return {
    __html: `<a href="${escapeHtml(href)}" title="${escapeHtml(title)}">${escapeHtml(label)}</a>`
  };
}

function externalLinkHtml(href: string, label: string, title = href): HtmlFragment {
  return {
    __html: `<a href="${escapeHtml(href)}" title="${escapeHtml(title)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
  };
}

function htmlFragment(html: string): HtmlFragment {
  return { __html: html };
}

function hashHtml(value: unknown): unknown {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  return withTitle(shortValue(text), text, "mono");
}

function withTitle(label: unknown, title: unknown, className?: string): HtmlFragment | unknown {
  const labelText = stringValue(label);
  const titleText = stringValue(title);
  if (!labelText || !titleText || labelText === titleText) {
    return label;
  }
  const classAttr = className ? ` class="${escapeHtml(className)}"` : "";
  return {
    __html: `<span${classAttr} title="${escapeHtml(titleText)}">${escapeHtml(labelText)}</span>`
  };
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return '<span class="muted">not set</span>';
  }
  if (isHtmlFragment(value)) {
    return value.__html;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '<span class="muted">none</span>';
    }
    return value.map((item) => renderValue(item)).join(", ");
  }
  if (typeof value === "string") {
    return escapeHtml(value);
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return escapeHtml(String(value));
  }
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function isHtmlFragment(value: unknown): value is HtmlFragment {
  return Boolean(value && typeof value === "object" && typeof (value as HtmlFragment).__html === "string");
}

function primaryCertificate(status: Record<string, any>): Record<string, any> | undefined {
  const certificate = status.certificate?.certificates?.[0];
  return certificate && typeof certificate === "object" ? certificate : undefined;
}

function runtimeLabel(status: Record<string, any>): string {
  const platform = `${status.runtime?.platform ?? "unknown"} ${status.runtime?.arch ?? ""}`.trim();
  const node = stringValue(status.runtime?.nodeVersion);
  return node ? `${platform} / ${node}` : platform;
}

function deploymentInfo(value: unknown): DeploymentInfo | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { id?: unknown; origin?: { kind?: unknown } };
    const id = stringValue(parsed.id);
    const kind = stringValue(parsed.origin?.kind);
    if (id) {
      return { raw: text, id, kind };
    }
  } catch {
    // Plain deployment ids are already displayable.
  }
  return /^[0-9]+$/.test(text) ? { raw: text, id: text } : { raw: text };
}

function deploymentHtml(info: DeploymentInfo | undefined): HtmlFragment | undefined {
  if (!info) {
    return undefined;
  }
  if (!info.id) {
    return withTitle(shortValue(info.raw), info.raw) as HtmlFragment;
  }
  const href = `https://hub.acurast.com/explorer/deployment/${encodeURIComponent(info.id)}`;
  const prefix = info.kind ? `${info.kind} deployment ` : "deployment ";
  const link = externalLinkHtml(href, info.id);
  return htmlFragment(
    `<span title="${escapeHtml(info.raw)}">${escapeHtml(prefix)}${link.__html}</span>`
  );
}

function assetHubBlockHtml(value: unknown): HtmlFragment | undefined {
  const block = scalarValue(value);
  if (!block) {
    return undefined;
  }
  return externalLinkHtml(`https://assethub-polkadot.subscan.io/block/${encodeURIComponent(block)}`, block);
}

function blockSecondaryHtml(value: unknown): HtmlFragment | undefined {
  const block = assetHubBlockHtml(value);
  return block ? htmlFragment(`block ${block.__html}`) : undefined;
}

function knownGatewayId(status: Record<string, any>): string | undefined {
  return stringValue(status.routing?.gatewayId) ?? stringValue(status.gatewayId) ?? stringValue(status.gateway?.gatewayId);
}

function knownJobEndAt(status: Record<string, any>): string | undefined {
  const scheduleEndMs = firstNumber(
    status.acurast?.scheduleEndMs,
    status.runtime?.acurastScheduleEndMs,
    status.runtime?.scheduleEndMs
  );
  if (scheduleEndMs !== undefined) {
    return formatDateTime(new Date(scheduleEndMs).toISOString());
  }

  const scheduleEndIso =
    stringValue(status.acurast?.scheduleEndIso) ??
    stringValue(status.acurast?.scheduleEndAt) ??
    stringValue(status.runtime?.scheduleEndIso) ??
    stringValue(status.runtime?.jobEndAt);
  if (scheduleEndIso) {
    return formatDateTime(scheduleEndIso);
  }

  const executionMs = firstNumber(
    status.acurast?.executionMs,
    status.runtime?.acurastExecutionMs,
    status.runtime?.executionMs
  );
  const startedAt = stringValue(status.startedAt);
  if (executionMs === undefined || !startedAt) {
    return undefined;
  }
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return undefined;
  }
  return formatDateTime(new Date(startedAtMs + executionMs).toISOString());
}

function optionalRow(label: string, value: unknown): Array<[string, unknown]> {
  return value === undefined || value === null || value === "" ? [] : [[label, value]];
}

function formatAddressList(addresses: unknown): string | undefined {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return undefined;
  }
  return addresses
    .map((item) => {
      const record = item as Record<string, unknown>;
      const address = stringValue(record.address);
      const family = record.family ? `IPv${record.family}` : undefined;
      return [address, family].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

function formatDateTime(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${rest}s` : `${minutes}m ${rest}s`;
}

function shortValue(value: string): string {
  if (/^0x[0-9a-fA-F]{24,}$/.test(value)) {
    return `${value.slice(0, 10)}...${value.slice(-8)}`;
  }
  if (value.length > 42) {
    return `${value.slice(0, 24)}...${value.slice(-14)}`;
  }
  return value;
}

function shortHostname(value: string): string {
  return value.length > 38 ? `${value.slice(0, 24)}...${value.slice(-14)}` : value;
}

function boolLabel(value: unknown): string {
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  return "unknown";
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = numberValue(value);
    if (number !== undefined) {
      return number;
    }
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.length > 0 ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function scalarValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

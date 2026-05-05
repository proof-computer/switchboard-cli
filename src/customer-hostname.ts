import { Resolver, resolveCname, resolveNs } from "node:dns/promises";
import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { signatureVerify } from "@polkadot/util-crypto";

import { normalizeDnsHostname, normalizeDnsRecordName } from "./cloudflare-dns.js";
import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, endpointHash } from "./registration.js";

export const CUSTOMER_HOSTNAME_ATTACHMENT_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  CustomerHostnameAttachment: [
    { name: "action", type: "string" },
    { name: "endpointId", type: "string" },
    { name: "endpointHostname", type: "string" },
    { name: "customerHostname", type: "string" },
    { name: "sessionId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

export type CustomerHostnameAction = "attachCustomerHostname" | "removeCustomerHostname";
export type CustomerHostnameTlsMode = "proof-acme" | "byo-certificate";
export type CustomerHostnameCertificateValidationMode = "dns01-cname-delegation" | "dns01-manual";
export type CustomerHostnameSignatureScheme = "eip712-secp256k1" | "substrate-sr25519";

export interface CustomerHostnameAttachmentPayload {
  action: CustomerHostnameAction;
  endpointId: string;
  endpointHostname: string;
  customerHostname: string;
  sessionId: string;
  nonce: string | bigint | number;
  deadline: string | bigint | number;
}

export interface CnameResolverResult {
  resolver: string;
  ok: boolean;
  chain: string[];
  error?: string;
}

export interface CnameValidationResult {
  ok: boolean;
  customerHostname: string;
  expectedTarget: string;
  results: CnameResolverResult[];
}

export interface DnsProviderHintProvider {
  name: string;
  loginUrl: string;
  docsUrl?: string;
}

export interface DnsProviderHint {
  zone?: string;
  nameServers: string[];
  provider?: DnsProviderHintProvider;
  error?: string;
}

export interface CustomerHostnameCertificateInstructions {
  mode: CustomerHostnameCertificateValidationMode;
  challengeName: string;
  type: "CNAME" | "TXT";
  name: string;
  value?: string;
  summary: string;
  note?: string;
}

const DNS_PROVIDER_HINTS: Array<{ provider: DnsProviderHintProvider; matches: string[] }> = [
  {
    provider: {
      name: "Cloudflare",
      loginUrl: "https://dash.cloudflare.com/",
      docsUrl: "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/"
    },
    matches: ["cloudflare.com"]
  },
  {
    provider: {
      name: "AWS Route 53",
      loginUrl: "https://console.aws.amazon.com/route53/v2/hostedzones",
      docsUrl: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html"
    },
    matches: ["awsdns-", "awsdns."]
  },
  {
    provider: {
      name: "GoDaddy",
      loginUrl: "https://dcc.godaddy.com/control/dns",
      docsUrl: "https://www.godaddy.com/help/add-a-cname-record-19236"
    },
    matches: ["domaincontrol.com"]
  },
  {
    provider: {
      name: "Namecheap",
      loginUrl: "https://ap.www.namecheap.com/domains/list/",
      docsUrl: "https://www.namecheap.com/support/knowledgebase/article.aspx/9646/10/how-can-i-set-up-a-cname-record-for-my-domain/"
    },
    matches: ["registrar-servers.com", "namecheap.com"]
  },
  {
    provider: {
      name: "Google Cloud DNS",
      loginUrl: "https://console.cloud.google.com/net-services/dns/zones",
      docsUrl: "https://cloud.google.com/dns/docs/records"
    },
    matches: ["googledomains.com", "cloud-dns", "google.com"]
  },
  {
    provider: {
      name: "DigitalOcean",
      loginUrl: "https://cloud.digitalocean.com/networking/domains",
      docsUrl: "https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/"
    },
    matches: ["digitalocean.com"]
  },
  {
    provider: {
      name: "DNSimple",
      loginUrl: "https://dnsimple.com/domains",
      docsUrl: "https://support.dnsimple.com/articles/cname-record/"
    },
    matches: ["dnsimple.com"]
  },
  {
    provider: {
      name: "Netlify DNS",
      loginUrl: "https://app.netlify.com/teams/current/dns",
      docsUrl: "https://docs.netlify.com/domains-https/netlify-dns/dns-records/"
    },
    matches: ["netlifydns.com"]
  },
  {
    provider: {
      name: "Vercel DNS",
      loginUrl: "https://vercel.com/dashboard/domains",
      docsUrl: "https://vercel.com/docs/domains/managing-dns-records"
    },
    matches: ["vercel-dns.com"]
  },
  {
    provider: {
      name: "Azure DNS",
      loginUrl: "https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.Network%2Fdnszones",
      docsUrl: "https://learn.microsoft.com/azure/dns/dns-operations-recordsets-portal"
    },
    matches: ["azure-dns.com"]
  },
  {
    provider: {
      name: "NS1",
      loginUrl: "https://my.nsone.net/",
      docsUrl: "https://help.ns1.com/hc/en-us/articles/360026590633-CNAME-records"
    },
    matches: ["nsone.net"]
  },
  {
    provider: {
      name: "Linode",
      loginUrl: "https://cloud.linode.com/domains",
      docsUrl: "https://www.linode.com/docs/products/networking/dns-manager/guides/manage-dns-records/"
    },
    matches: ["linode.com"]
  },
  {
    provider: {
      name: "Hetzner DNS",
      loginUrl: "https://dns.hetzner.com/",
      docsUrl: "https://docs.hetzner.com/dns-console/dns/general/records/"
    },
    matches: ["hetzner.com"]
  },
  {
    provider: {
      name: "Porkbun",
      loginUrl: "https://porkbun.com/account/domainsSpeedy",
      docsUrl: "https://kb.porkbun.com/article/91-how-to-edit-dns-records"
    },
    matches: ["porkbun.com"]
  },
  {
    provider: {
      name: "Hover",
      loginUrl: "https://www.hover.com/control_panel/domains",
      docsUrl: "https://help.hover.com/hc/en-us/articles/217281647-How-to-add-a-CNAME-record"
    },
    matches: ["hover.com"]
  },
  {
    provider: {
      name: "Wix",
      loginUrl: "https://manage.wix.com/account/domains",
      docsUrl: "https://support.wix.com/en/article/adding-or-updating-cname-records-in-your-wix-account"
    },
    matches: ["wixdns.net"]
  },
  {
    provider: {
      name: "Squarespace",
      loginUrl: "https://account.squarespace.com/domains",
      docsUrl: "https://support.squarespace.com/hc/en-us/articles/360002101888"
    },
    matches: ["squarespacedns.com"]
  }
];

export function customerHostnameAttachmentDomain(chainId: bigint | number | string, verifyingContract: string) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract
  };
}

export function normalizeCustomerHostnameAttachment(
  attachment: CustomerHostnameAttachmentPayload
): CustomerHostnameAttachmentPayload {
  return {
    action: attachment.action,
    endpointId: attachment.endpointId.trim().toLowerCase(),
    endpointHostname: normalizeDnsHostname(attachment.endpointHostname),
    customerHostname: normalizeDnsHostname(attachment.customerHostname),
    sessionId: ethers.hexlify(attachment.sessionId),
    nonce: attachment.nonce.toString(),
    deadline: attachment.deadline.toString()
  };
}

export async function signCustomerHostnameAttachment(
  wallet: ethers.Wallet,
  chainId: bigint | number | string,
  verifyingContract: string,
  attachment: CustomerHostnameAttachmentPayload
): Promise<string> {
  return wallet.signTypedData(
    customerHostnameAttachmentDomain(chainId, verifyingContract),
    CUSTOMER_HOSTNAME_ATTACHMENT_TYPES,
    normalizeCustomerHostnameAttachment(attachment)
  );
}

export function recoverCustomerHostnameAttachmentSigner(
  chainId: bigint | number | string,
  verifyingContract: string,
  attachment: CustomerHostnameAttachmentPayload,
  signature: string
): string {
  return ethers.verifyTypedData(
    customerHostnameAttachmentDomain(chainId, verifyingContract),
    CUSTOMER_HOSTNAME_ATTACHMENT_TYPES,
    normalizeCustomerHostnameAttachment(attachment),
    signature
  );
}

export function customerHostnameAttachmentSubstratePayload(
  chainId: bigint | number | string,
  verifyingContract: string,
  attachment: CustomerHostnameAttachmentPayload
): Uint8Array {
  const payload = {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: chainId.toString(),
      verifyingContract: ethers.getAddress(verifyingContract)
    },
    primaryType: "CustomerHostnameAttachment",
    message: normalizeCustomerHostnameAttachment(attachment)
  };
  return Buffer.from(`PROOF CustomerHostnameAttachment v1\n${JSON.stringify(payload)}`, "utf8");
}

export function verifyCustomerHostnameAttachmentSubstrateSignature(input: {
  chainId: bigint | number | string;
  verifyingContract: string;
  attachment: CustomerHostnameAttachmentPayload;
  signature: string;
  signer: string;
}): boolean {
  return signatureVerify(
    customerHostnameAttachmentSubstratePayload(input.chainId, input.verifyingContract, input.attachment),
    input.signature,
    input.signer
  ).isValid;
}

export function customerHostnameInstructions(customerHostname: string, endpointHostname: string) {
  const normalizedCustomerHostname = normalizeDnsHostname(customerHostname);
  const normalizedEndpointHostname = normalizeDnsHostname(endpointHostname);
  return {
    type: "CNAME" as const,
    name: normalizedCustomerHostname,
    value: normalizedEndpointHostname,
    summary: `${normalizedCustomerHostname} CNAME ${normalizedEndpointHostname}`
  };
}

export function customerHostnameAcmeChallengeName(customerHostname: string): string {
  return normalizeDnsRecordName(`_acme-challenge.${normalizeDnsHostname(customerHostname)}`);
}

export function customerHostnameAcmeDelegationTarget(input: {
  customerHostname: string;
  endpointHostname: string;
  delegationSuffix?: string;
}): string {
  const customerHostname = normalizeDnsHostname(input.customerHostname);
  const endpointHostname = normalizeDnsHostname(input.endpointHostname);
  const suffix = normalizeDnsRecordName(input.delegationSuffix ?? `_acme-challenge.${endpointHostname}`);
  const digest = createHash("sha256").update(customerHostname).digest("hex").slice(0, 32);
  return normalizeDnsRecordName(`${digest}.${suffix}`);
}

export function customerHostnameCertificateInstructions(input: {
  customerHostname: string;
  endpointHostname: string;
  mode?: CustomerHostnameCertificateValidationMode;
  delegationSuffix?: string;
  manualTxtValue?: string;
}): CustomerHostnameCertificateInstructions {
  const mode = input.mode ?? "dns01-cname-delegation";
  const challengeName = customerHostnameAcmeChallengeName(input.customerHostname);
  if (mode === "dns01-manual") {
    return {
      mode,
      challengeName,
      type: "TXT",
      name: challengeName,
      value: input.manualTxtValue,
      summary: input.manualTxtValue
        ? `${challengeName} TXT "${input.manualTxtValue}"`
        : `${challengeName} TXT <shown when the Acurast job requests the certificate>`,
      note: "Manual DNS-01 mode requires adding the current TXT value each time certificate issuance asks for one."
    };
  }

  const value = customerHostnameAcmeDelegationTarget({
    customerHostname: input.customerHostname,
    endpointHostname: input.endpointHostname,
    delegationSuffix: input.delegationSuffix
  });
  return {
    mode,
    challengeName,
    type: "CNAME",
    name: challengeName,
    value,
    summary: `${challengeName} CNAME ${value}`,
    note: "Create this once so PROOF can answer future ACME DNS-01 challenges for this hostname."
  };
}

export function dnsProviderHintFromNameServers(nameServers: string[]): DnsProviderHintProvider | undefined {
  const normalizedNameServers = nameServers.map(normalizeNameServer);
  return DNS_PROVIDER_HINTS.find((hint) =>
    normalizedNameServers.some((nameServer) => hint.matches.some((match) => nameServer.includes(match)))
  )?.provider;
}

export async function lookupDnsProviderHint(hostname: string): Promise<DnsProviderHint> {
  let normalizedHostname: string;
  try {
    normalizedHostname = normalizeDnsHostname(hostname);
  } catch (error) {
    return {
      nameServers: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const labels = normalizedHostname.split(".");
  let lastError: string | undefined;
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const zone = labels.slice(index).join(".");
    try {
      const nameServers = (await resolveNs(zone)).map(normalizeNameServer).sort();
      if (nameServers.length === 0) {
        lastError = `no NS records for ${zone}`;
        continue;
      }
      return {
        zone,
        nameServers,
        provider: dnsProviderHintFromNameServers(nameServers)
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    nameServers: [],
    error: lastError ?? `no NS records found for ${normalizedHostname}`
  };
}

export function validateCustomerHostnamePolicy(customerHostname: string, endpointHostname: string): void {
  const normalizedCustomerHostname = normalizeDnsHostname(customerHostname);
  const normalizedEndpointHostname = normalizeDnsHostname(endpointHostname);
  if (normalizedCustomerHostname === normalizedEndpointHostname) {
    throw new Error("customer hostname must differ from endpoint hostname");
  }
  if (normalizedCustomerHostname.split(".").length < 3) {
    throw new Error("v1 customer hostnames must be subdomains; apex/root domains are not supported");
  }
}

export function endpointHashMatchesHostname(sessionEndpointHash: string, endpointHostname: string): boolean {
  return sessionEndpointHash.toLowerCase() === endpointHash(normalizeDnsHostname(endpointHostname)).toLowerCase();
}

export async function validateCnameTarget(input: {
  customerHostname: string;
  expectedTarget: string;
  resolvers?: string[];
  maxDepth?: number;
}): Promise<CnameValidationResult> {
  const customerHostname = normalizeDnsHostname(input.customerHostname);
  const expectedTarget = normalizeDnsHostname(input.expectedTarget);
  const resolvers = input.resolvers && input.resolvers.length > 0 ? input.resolvers : ["system", "1.1.1.1", "8.8.8.8"];
  const results = await Promise.all(
    resolvers.map(async (resolver) => validateCnameWithResolver(customerHostname, expectedTarget, resolver, input.maxDepth ?? 8))
  );
  return {
    ok: results.length > 0 && results.every((result) => result.ok),
    customerHostname,
    expectedTarget,
    results
  };
}

async function validateCnameWithResolver(
  customerHostname: string,
  expectedTarget: string,
  resolverName: string,
  maxDepth: number
): Promise<CnameResolverResult> {
  const chain: string[] = [customerHostname];
  let current = customerHostname;
  try {
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const records = (await resolveCnameRecords(current, resolverName)).map(normalizeDnsHostname);
      if (records.length === 0) {
        return {
          resolver: resolverName,
          ok: current === expectedTarget,
          chain,
          error: current === expectedTarget ? undefined : `no CNAME record for ${current}`
        };
      }
      const next = records[0];
      chain.push(next);
      if (next === expectedTarget) {
        return {
          resolver: resolverName,
          ok: true,
          chain
        };
      }
      current = next;
    }
    return {
      resolver: resolverName,
      ok: false,
      chain,
      error: `CNAME chain exceeded ${maxDepth} hops`
    };
  } catch (error) {
    return {
      resolver: resolverName,
      ok: false,
      chain,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function resolveCnameRecords(hostname: string, resolverName: string): Promise<string[]> {
  if (resolverName === "system") {
    return resolveCname(hostname);
  }
  const resolver = new Resolver();
  resolver.setServers([resolverName]);
  return resolver.resolveCname(hostname);
}

function normalizeNameServer(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { u8aToHex } from "@polkadot/util";

import {
  customerHostnameAcmeChallengeName,
  customerHostnameAcmeDelegationTarget,
  customerHostnameAttachmentSubstratePayload,
  customerHostnameCertificateInstructions,
  dnsProviderHintFromNameServers,
  verifyCustomerHostnameAttachmentSubstrateSignature
} from "../src/customer-hostname.js";
import { accountFromUri } from "../src/polkadot.js";

describe("customer hostname DNS provider hints", () => {
  it("identifies Cloudflare nameservers", () => {
    const provider = dnsProviderHintFromNameServers(["ada.ns.cloudflare.com", "ben.ns.cloudflare.com."]);

    assert.equal(provider?.name, "Cloudflare");
    assert.equal(provider?.loginUrl, "https://dash.cloudflare.com/");
  });

  it("identifies AWS Route 53 nameservers", () => {
    const provider = dnsProviderHintFromNameServers(["ns-123.awsdns-45.com", "ns-678.awsdns-90.net"]);

    assert.equal(provider?.name, "AWS Route 53");
    assert.equal(provider?.loginUrl, "https://console.aws.amazon.com/route53/v2/hostedzones");
  });

  it("identifies common registrar DNS providers", () => {
    assert.equal(dnsProviderHintFromNameServers(["dns1.registrar-servers.com"])?.name, "Namecheap");
    assert.equal(dnsProviderHintFromNameServers(["ns71.domaincontrol.com"])?.name, "GoDaddy");
  });

  it("returns undefined for unknown nameservers", () => {
    const provider = dnsProviderHintFromNameServers(["ns1.example.net", "ns2.example.net"]);

    assert.equal(provider, undefined);
  });
});

describe("customer hostname ACME DNS-01 instructions", () => {
  it("builds stable _acme-challenge CNAME delegation instructions by default", () => {
    const instructions = customerHostnameCertificateInstructions({
      customerHostname: "App.Customer.Example.Com",
      endpointHostname: "abc.ingress.guru"
    });

    assert.equal(instructions.mode, "dns01-cname-delegation");
    assert.equal(instructions.type, "CNAME");
    assert.equal(instructions.name, "_acme-challenge.app.customer.example.com");
    assert.match(instructions.value ?? "", /^[0-9a-f]{32}\._acme-challenge\.abc\.ingress\.guru$/);
    assert.equal(
      customerHostnameAcmeDelegationTarget({
        customerHostname: "app.customer.example.com",
        endpointHostname: "abc.ingress.guru"
      }),
      instructions.value
    );
  });

  it("builds manual TXT instructions with the current challenge value when present", () => {
    const instructions = customerHostnameCertificateInstructions({
      customerHostname: "app.customer.example.com",
      endpointHostname: "abc.ingress.guru",
      mode: "dns01-manual",
      manualTxtValue: "challenge-token"
    });

    assert.equal(customerHostnameAcmeChallengeName("app.customer.example.com"), "_acme-challenge.app.customer.example.com");
    assert.equal(instructions.mode, "dns01-manual");
    assert.equal(instructions.type, "TXT");
    assert.equal(instructions.summary, '_acme-challenge.app.customer.example.com TXT "challenge-token"');
  });
});

describe("customer hostname native signatures", () => {
  it("verifies Substrate signatures over normalized attachment payloads", async () => {
    const account = await accountFromUri("//Alice", 42);
    const attachment = {
      action: "attachCustomerHostname" as const,
      endpointId: "Deck.Endpoint.Example",
      endpointHostname: "Deck.Endpoint.Example",
      customerHostname: "Pitch.Customer.Example",
      sessionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      nonce: "7",
      deadline: "9999999999"
    };
    const signature = u8aToHex(
      account.sign(
        customerHostnameAttachmentSubstratePayload(
          420420419,
          "0x65d6B76BeC50F46D198fFa3598E381a298025Da0",
          attachment
        )
      )
    );

    assert.equal(
      verifyCustomerHostnameAttachmentSubstrateSignature({
        chainId: 420420419,
        verifyingContract: "0x65d6B76BeC50F46D198fFa3598E381a298025Da0",
        attachment,
        signature,
        signer: account.address
      }),
      true
    );
    assert.equal(
      verifyCustomerHostnameAttachmentSubstrateSignature({
        chainId: 420420419,
        verifyingContract: "0x65d6B76BeC50F46D198fFa3598E381a298025Da0",
        attachment: {
          ...attachment,
          customerHostname: "other.customer.example"
        },
        signature,
        signer: account.address
      }),
      false
    );
  });
});

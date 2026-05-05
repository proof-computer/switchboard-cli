import { ethers } from "ethers";

import type { IngressQuote } from "./ingress-quote.js";
import { endpointHash } from "./registration.js";

export interface IngressQuoteBindingRequest {
  developer: string;
  asset: string;
  paidSeconds: string | bigint | number;
  maxAmount?: string | bigint | number;
  expectedJobSigner: string;
  jobId?: string;
  operatorId?: string;
  processorId?: string;
  endpointHash?: string;
  endpointHostname?: string;
  salt?: string;
}

export function assertIngressQuoteMatchesRequest(
  quote: IngressQuote,
  request: IngressQuoteBindingRequest
): void {
  const developer = ethers.getAddress(request.developer);
  const asset = ethers.getAddress(request.asset);
  const expectedJobSigner = ethers.getAddress(request.expectedJobSigner);
  const paidSeconds = parseUint(request.paidSeconds, "requested paidSeconds");

  if (ethers.getAddress(quote.developer) !== developer) {
    throw new Error(`Quote developer ${quote.developer} does not match requested developer ${developer}`);
  }
  if (ethers.getAddress(quote.asset) !== asset) {
    throw new Error(`Quote asset ${quote.asset} does not match requested asset ${asset}`);
  }
  if (quote.paidSeconds !== paidSeconds) {
    throw new Error(`Quote paidSeconds ${quote.paidSeconds.toString()} does not match requested paidSeconds ${paidSeconds.toString()}`);
  }
  if (request.maxAmount !== undefined) {
    const maxAmount = parseUint(request.maxAmount, "requested maxAmount");
    if (quote.amount !== maxAmount || quote.maxAmount !== maxAmount) {
      throw new Error(`Quote amount ${quote.amount.toString()} does not match requested maxAmount ${maxAmount.toString()}`);
    }
  }
  if (ethers.getAddress(quote.expectedJobSigner) !== expectedJobSigner) {
    throw new Error(`Quote expectedJobSigner ${quote.expectedJobSigner} does not match requested job signer ${expectedJobSigner}`);
  }

  assertOptionalBytes32("jobId", quote.jobId, request.jobId);
  assertOptionalBytes32("operatorId", quote.operatorId, request.operatorId);
  assertOptionalBytes32("processorId", quote.processorId, request.processorId);
  assertOptionalBytes32("salt", quote.salt, request.salt);

  if (request.endpointHash) {
    assertOptionalBytes32("endpointHash", quote.endpointHash, request.endpointHash);
  } else if (request.endpointHostname) {
    const requestedEndpointHash = endpointHash(request.endpointHostname);
    if (normalizeBytes32(quote.endpointHash, "quote.endpointHash") !== requestedEndpointHash) {
      throw new Error(`Quote endpointHash ${quote.endpointHash} does not match requested endpoint hostname ${request.endpointHostname}`);
    }
  }
}

function assertOptionalBytes32(name: string, actual: string, expected: string | undefined): void {
  if (!expected) return;
  const normalizedActual = normalizeBytes32(actual, `quote.${name}`);
  const normalizedExpected = normalizeBytes32(expected, `requested ${name}`);
  if (normalizedActual !== normalizedExpected) {
    throw new Error(`Quote ${name} ${actual} does not match requested ${name} ${normalizedExpected}`);
  }
}

function normalizeBytes32(value: string, name: string): string {
  const hex = ethers.hexlify(value);
  if (ethers.dataLength(hex) !== 32) {
    throw new Error(`${name} must be bytes32`);
  }
  return hex.toLowerCase();
}

function parseUint(value: string | bigint | number, name: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${name} must be non-negative`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer string`);
  }
  return BigInt(value);
}

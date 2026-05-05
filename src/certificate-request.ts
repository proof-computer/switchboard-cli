import { ethers } from "ethers";

import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION } from "./registration.js";

export const CERTIFICATE_REQUEST_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  CertificateRequest: [
    { name: "sessionId", type: "bytes32" },
    { name: "jobSigner", type: "address" },
    { name: "hostname", type: "string" },
    { name: "csrHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

export interface CertificateRequestPayload {
  sessionId: string;
  jobSigner: string;
  hostname: string;
  csrHash: string;
  nonce: string | bigint | number;
  deadline: string | bigint | number;
}

export function certificateRequestDomain(chainId: bigint | number | string, verifyingContract: string) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract
  };
}

export function csrPemHash(csrPem: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(csrPem));
}

export function normalizeCertificateRequest(request: CertificateRequestPayload): CertificateRequestPayload {
  return {
    sessionId: ethers.hexlify(request.sessionId),
    jobSigner: ethers.getAddress(request.jobSigner),
    hostname: request.hostname.trim().toLowerCase(),
    csrHash: ethers.hexlify(request.csrHash),
    nonce: request.nonce.toString(),
    deadline: request.deadline.toString()
  };
}

export function certificateRequestDigest(
  chainId: bigint | number | string,
  verifyingContract: string,
  request: CertificateRequestPayload
): string {
  return ethers.TypedDataEncoder.hash(
    certificateRequestDomain(chainId, verifyingContract),
    CERTIFICATE_REQUEST_TYPES,
    normalizeCertificateRequest(request)
  );
}

export async function signCertificateRequest(
  wallet: ethers.Wallet,
  chainId: bigint | number | string,
  verifyingContract: string,
  request: CertificateRequestPayload
): Promise<string> {
  return wallet.signTypedData(
    certificateRequestDomain(chainId, verifyingContract),
    CERTIFICATE_REQUEST_TYPES,
    normalizeCertificateRequest(request)
  );
}

export function recoverCertificateRequestSigner(
  chainId: bigint | number | string,
  verifyingContract: string,
  request: CertificateRequestPayload,
  signature: string
): string {
  return ethers.verifyTypedData(
    certificateRequestDomain(chainId, verifyingContract),
    CERTIFICATE_REQUEST_TYPES,
    normalizeCertificateRequest(request),
    signature
  );
}

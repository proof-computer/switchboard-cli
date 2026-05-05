import { ethers } from "ethers";

export const EIP712_DOMAIN_NAME = "ProofIngress";
export const EIP712_DOMAIN_VERSION = "1";

export const REGISTRATION_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Registration: [
    { name: "sessionId", type: "bytes32" },
    { name: "jobId", type: "bytes32" },
    { name: "jobSigner", type: "address" },
    { name: "operatorId", type: "bytes32" },
    { name: "processorId", type: "bytes32" },
    { name: "endpointHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

export interface RegistrationPayload {
  sessionId: string;
  jobId: string;
  jobSigner: string;
  operatorId: string;
  processorId: string;
  endpointHash: string;
  nonce: string | bigint | number;
  deadline: string | bigint | number;
}

export function registrationDomain(chainId: bigint | number | string, verifyingContract: string) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract
  };
}

export function registrationDigest(
  chainId: bigint | number | string,
  verifyingContract: string,
  registration: RegistrationPayload
): string {
  return ethers.TypedDataEncoder.hash(
    registrationDomain(chainId, verifyingContract),
    REGISTRATION_TYPES,
    normalizeRegistration(registration)
  );
}

export function idBytes32(value: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

export function endpointHash(hostname: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(hostname.toLowerCase()));
}

export function normalizeRegistration(registration: RegistrationPayload): RegistrationPayload {
  return {
    sessionId: ethers.hexlify(registration.sessionId),
    jobId: ethers.hexlify(registration.jobId),
    jobSigner: ethers.getAddress(registration.jobSigner),
    operatorId: ethers.hexlify(registration.operatorId),
    processorId: ethers.hexlify(registration.processorId),
    endpointHash: ethers.hexlify(registration.endpointHash),
    nonce: registration.nonce.toString(),
    deadline: registration.deadline.toString()
  };
}

export async function signRegistration(
  wallet: ethers.Wallet,
  chainId: bigint | number | string,
  verifyingContract: string,
  registration: RegistrationPayload
): Promise<string> {
  return wallet.signTypedData(
    registrationDomain(chainId, verifyingContract),
    REGISTRATION_TYPES,
    normalizeRegistration(registration)
  );
}

export function recoverRegistrationSigner(
  chainId: bigint | number | string,
  verifyingContract: string,
  registration: RegistrationPayload,
  signature: string
): string {
  return ethers.verifyTypedData(
    registrationDomain(chainId, verifyingContract),
    REGISTRATION_TYPES,
    normalizeRegistration(registration),
    signature
  );
}

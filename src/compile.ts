import fs from "node:fs";
import path from "node:path";
import type { InterfaceAbi } from "ethers";
import solc from "solc";

export interface ContractArtifact {
  abi: InterfaceAbi;
  bytecode: string;
}

export function compileContracts(): Record<string, ContractArtifact> {
  const sources = Object.fromEntries(
    ["IngressRegistry.sol", "MockERC20.sol", "RecorderCoordinator.sol"].map((fileName) => {
      const filePath = path.join(process.cwd(), "contracts", fileName);
      return [
        fileName,
        {
          content: fs.readFileSync(filePath, "utf8")
        }
      ];
    })
  );

  const input = {
    language: "Solidity",
    sources,
    settings: {
      evmVersion: "paris",
      optimizer: {
        enabled: true,
        runs: 200
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"]
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = output.errors ?? [];
  const fatalErrors = errors.filter((error: { severity: string }) => error.severity === "error");

  if (fatalErrors.length > 0) {
    throw new Error(fatalErrors.map((error: { formattedMessage: string }) => error.formattedMessage).join("\n"));
  }

  const artifacts: Record<string, ContractArtifact> = {};
  for (const contractsByName of Object.values(output.contracts ?? {}) as Array<Record<string, any>>) {
    for (const [contractName, contractOutput] of Object.entries(contractsByName)) {
      artifacts[contractName] = {
        abi: contractOutput.abi as InterfaceAbi,
        bytecode: `0x${contractOutput.evm.bytecode.object}`
      };
    }
  }

  return artifacts;
}

export function getContractArtifact(contractName: string): ContractArtifact {
  const artifact = compileContracts()[contractName];
  if (!artifact) {
    throw new Error(`Contract artifact not found: ${contractName}`);
  }

  return artifact;
}

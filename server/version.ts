import packageJson from "../package.json";

export const APP_NAME = packageJson.name;
export const APP_VERSION = packageJson.version;
export const MCP_CONTRACT_VERSION = "0.1";

export function versionInfo() {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    mcpContractVersion: MCP_CONTRACT_VERSION,
    platform: process.platform,
    arch: process.arch,
    bunVersion: typeof Bun !== "undefined" ? Bun.version : null,
  };
}

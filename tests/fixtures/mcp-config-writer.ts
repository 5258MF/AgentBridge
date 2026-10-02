import { addMcpServerConfiguration } from "../../src/extension/src/mcp-config-editor.js";

const [file, prefix] = process.argv.slice(2);
async function main(): Promise<void> {
  for (let index = 0; index < 3; index++) await addMcpServerConfiguration(file!, `${prefix}${index}`, { command: "node" });
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });

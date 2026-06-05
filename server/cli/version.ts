import { versionInfo } from "../version";
import { print } from "./shared";

export function versionCommand(): void {
  print(versionInfo());
}

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import registerAllowlist from "./allowlist";
import registerPrompts from "./append-system";

export default function modelToolkit(pi: ExtensionAPI) {
  registerAllowlist(pi);
  registerPrompts(pi);
  pi.setLabel("OMP Model Toolkit");
}

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import registerAllowlist from "./allowlist";
import registerPrompts from "./append-system";
import { createGatewaySync } from "./gateway-sync";

export default function modelToolkit(pi: ExtensionAPI) {
  const gateways = createGatewaySync();
  pi.on("session_start", (_event, ctx) => gateways.start(ctx));
  pi.on("session_switch", (_event, ctx) => gateways.start(ctx));
  pi.on("session_shutdown", () => gateways.stop());
  registerAllowlist(pi, gateways);
  registerPrompts(pi, gateways);
  pi.setLabel("OMP Model Toolkit");
}

import type { LlmClient } from "../client.js";

/** Every stage takes the client and the model id it should run on; nothing else is ambient. */
export interface StageDeps {
  client: LlmClient;
  model: string;
}

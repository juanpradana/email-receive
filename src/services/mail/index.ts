import type { AppConfig } from "../../config.js";
import type { MailProvider } from "./provider.js";
import { createResendProvider } from "./resend.js";

export function createMailProvider(config: AppConfig): MailProvider {
  if (!config.resendApiKey) {
    throw new Error("RESEND_API_KEY not configured");
  }
  return createResendProvider(config.resendApiKey);
}
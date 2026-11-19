export interface MailProviderInput {
  fromAddr: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

export interface MailProviderResult {
  resendMessageId?: string;
  accepted: boolean;
  error?: string;
  /**
   * True when the provider signalled a terminal, non-retryable failure
   * (invalid address, unverified domain, 4xx). Transient failures
   * (5xx, 429, timeouts) leave this undefined/false so callers can retry.
   */
  terminal?: boolean;
}

export interface MailProvider {
  send(input: MailProviderInput): Promise<MailProviderResult>;
}

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
}

export interface MailProvider {
  send(input: MailProviderInput): Promise<MailProviderResult>;
}

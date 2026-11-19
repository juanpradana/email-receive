export interface Mailbox {
  baseUrl: string;
  apiKey: string;
  fromAddr: string;
}

/**
 * The webmail stores its credentials in localStorage under these keys. The
 * API key belongs to the tenant and is the only secret the frontend ever
 * sees; `RESEND_API_KEY` is server-side and never shipped to the browser.
 */
export function loadMailbox(): Mailbox | null {
  try {
    const baseUrl = localStorage.getItem("mail.baseUrl");
    const apiKey = localStorage.getItem("mail.apiKey");
    const fromAddr = localStorage.getItem("mail.fromAddr");
    if (!baseUrl || !apiKey) return null;
    return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, fromAddr: fromAddr ?? "" };
  } catch {
    return null;
  }
}

export function saveMailbox(mailbox: Mailbox): void {
  try {
    localStorage.setItem("mail.baseUrl", mailbox.baseUrl);
    localStorage.setItem("mail.apiKey", mailbox.apiKey);
    localStorage.setItem("mail.fromAddr", mailbox.fromAddr ?? "");
  } catch {
    // localStorage may be unavailable (private mode); the app degrades to
    // in-memory state via the React context.
  }
}

export function clearMailbox(): void {
  try {
    localStorage.removeItem("mail.baseUrl");
    localStorage.removeItem("mail.apiKey");
    localStorage.removeItem("mail.fromAddr");
  } catch {
    // Ignore — nothing to clear.
  }
}

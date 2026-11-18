export interface Storage {
  putRaw(id: string, bytes: Buffer): Promise<string>;
  putAttachment(messageId: string, partIndex: number, filename: string, bytes: Buffer): Promise<string>;
  putHtml(id: string, html: string): Promise<string>;
  read(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  sweepTmp(): Promise<void>;
}

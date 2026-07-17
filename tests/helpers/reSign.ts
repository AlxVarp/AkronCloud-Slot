import { createHmac } from "node:crypto";

/** Re-sign a JWT header.payload pair under HS256. Tests only. */
export async function reSign(
  secret: string,
  headerB64Url: string,
  payloadB64Url: string,
): Promise<string> {
  const data = `${headerB64Url}.${payloadB64Url}`;
  return createHmac("sha256", secret).update(data).digest("base64url");
}

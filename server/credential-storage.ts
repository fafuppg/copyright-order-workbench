import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
const prefix = "sealed:v1:";
function key() {
  const secret = process.env.SECRET_KEY;
  if (!secret || secret.length < 32)
    throw new Error("SECRET_KEY must be configured");
  return createHash("sha256").update(secret).digest();
}
export function protectCredentials(value: any, decrypt = false): any {
  if (Array.isArray(value))
    return value.map((v) => protectCredentials(v, decrypt));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, v]) => {
      if (name === "filingPassword" && typeof v === "string" && v) {
        if (decrypt && v.startsWith(prefix)) {
          const [iv, tag, bytes] = v.slice(prefix.length).split(".");
          const cipher = createDecipheriv(
            "aes-256-gcm",
            key(),
            Buffer.from(iv, "hex"),
          );
          cipher.setAuthTag(Buffer.from(tag, "hex"));
          return [
            name,
            Buffer.concat([
              cipher.update(Buffer.from(bytes, "base64")),
              cipher.final(),
            ]).toString(),
          ];
        }
        if (!decrypt) {
          const iv = randomBytes(12),
            cipher = createCipheriv("aes-256-gcm", key(), iv);
          const bytes = Buffer.concat([
            cipher.update(v, "utf8"),
            cipher.final(),
          ]);
          return [
            name,
            prefix +
              [
                iv.toString("hex"),
                cipher.getAuthTag().toString("hex"),
                bytes.toString("base64"),
              ].join("."),
          ];
        }
      }
      return [name, protectCredentials(v, decrypt)];
    }),
  );
}

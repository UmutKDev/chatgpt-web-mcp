import crypto from "node:crypto";

/** HMAC-signed, expiring download links for library images. */
export class FileSigner {
  private readonly secret: string;
  constructor(secret: string, private readonly ttlSec = 7 * 86_400) {
    this.secret = secret || crypto.randomBytes(32).toString("hex");
  }

  sign(imageId: string, now = Date.now()): { exp: number; sig: string } {
    const exp = Math.floor(now / 1000) + this.ttlSec;
    return { exp, sig: this.mac(imageId, exp) };
  }

  verify(imageId: string, exp: number, sig: string, now = Date.now()): boolean {
    if (!Number.isFinite(exp) || exp < Math.floor(now / 1000)) return false;
    const expected = Buffer.from(this.mac(imageId, exp));
    const given = Buffer.from(String(sig));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }

  url(base: string, imageId: string): string {
    const { exp, sig } = this.sign(imageId);
    return `${base}/files/${encodeURIComponent(imageId)}?exp=${exp}&sig=${sig}`;
  }

  private mac(id: string, exp: number): string {
    return crypto.createHmac("sha256", this.secret).update(`${id}.${exp}`).digest("base64url");
  }
}

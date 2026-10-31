import { describe, expect, it } from "vitest";
import { redactSecrets } from "./secrets";
import { renderTerminal } from "./snapshot";

describe("redactSecrets", () => {
  it.each([
    ["DB_PASSWORD=hunter2secret", "hunter2secret"],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
    ["MY_API_KEY=abc123def456ghi789", "abc123def456"],
    ['{"password": "correct horse battery staple"}', "horse battery"],
    ["PGPASSWORD=s3cr3tvalue psql", "s3cr3tvalue"],
    ["//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmn"],
    ["postgres://user:pa55word@db.example.com/app", "pa55word"],
    ["Authorization: Bearer abcdefghijklmnop1234567890", "abcdefghijklmnop12345"],
    ["key sk_live_51Habcdefghijklmnop0123", "51Habcdefghijklmnop"],
    ["token glpat-abcdefghij0123456789", "abcdefghij0123456789"],
    ["hf_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz"],
    ["https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXX"],
    ["DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789==", "abcdefghijklmnopqrstuvwxyz"],
    ["-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\nabc\n-----END PGP PRIVATE KEY BLOCK-----", "lQOYBF"],
  ])("removes %s", (text, secret) => {
    expect(redactSecrets(text)).not.toContain(secret);
  });

  it("keeps ordinary text and the names around a secret", () => {
    expect(redactSecrets("Run npm test, then open the dashboard.")).toBe("Run npm test, then open the dashboard.");
    expect(redactSecrets("DB_PASSWORD=hunter2secret")).toMatch(/^DB_\[removed: /);
  });

  it("stays fast on long text with no secret", () => {
    const started = Date.now();
    redactSecrets(`${"a".repeat(200_000)} ${"password ".repeat(5_000)} ${"x_".repeat(50_000)}`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("renderTerminal", () => {
  it("removes a private key that spans several output lines", () => {
    const lines = ["$ cat id_rsa", "-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA1234", "abcdefghijk", "-----END RSA PRIVATE KEY-----", "$"];
    const text = renderTerminal({ name: "zsh", cwd: "/src" }, null, lines, lines.length, 4_000);
    expect(text).not.toContain("MIIEowIBAAKCAQEA1234");
    expect(text).not.toContain("END RSA PRIVATE KEY");
    expect(text).toContain("$ cat id_rsa");
  });
});

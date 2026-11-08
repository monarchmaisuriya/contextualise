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

  // Made-up values in the shape of real keys: a bare key name, and Klaviyo's private keys (pk_ + 34).
  const fakeKlaviyo = `pk_${"a1b2c3d4e5f6".repeat(3).slice(0, 34)}`;
  it.each([
    [`KEY=${fakeKlaviyo}`],
    [fakeKlaviyo],
    [`Klaviyo key: ${fakeKlaviyo}`],
    [`use this ${fakeKlaviyo} for the import`],
    ['{"key": "Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg"}'],
    ["key = 8f14e45fceea167a5a36dedd4bea2543"],
    ["KLAVIYO_KEY='9b74c9897bac770ffc029102a200c5de'"],
  ])("removes a key with no api_ or secret_ in its name: %s", (text) => {
    expect(redactSecrets(text)).toContain("[removed: ");
    expect(redactSecrets(text)).not.toMatch(/a1b2c3d4|Zm9vYmFy|8f14e45f|9b74c989/);
  });

  it.each([
    ["key: string;"],
    ["<Row key={item.id} />"],
    ['onKey({ key: "Enter" })'],
    ["The key is to test first."],
    ["Paste the public key into the form."],
    ["primary key = id"],
    ["monkey=bananas1234567890abcdef"],
    ["pk_id and pk_column stay"],
    ["const keyFor = (row) => row.id;"],
    // Code values with digits that are not generated: dotted paths, files, words joined by - or _.
    ["key: posts.list.page2.cursor"],
    ["i18n key: checkout.payment.card_number_label2"],
    ["partition key = tenant_2024_11_orders"],
    ['key: "user-profile-2024-settings"'],
    ["key = 'src/components/UserProfile2.tsx'"],
    // Letters only, or digits only, however long.
    ["key: abcdefghijklmnopqrstuvwxyz"],
    ["key: 123456789012345678901234"],
    // 19 characters is below the limit.
    ["key=a1b2c3d4e5f6a1b2c3d"],
  ])("keeps ordinary uses of key: %s", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it("replaces exactly the secret, keeping the words around it and any closing quote", () => {
    expect(redactSecrets(`use this ${fakeKlaviyo} for the import`)).toBe("use this [removed: API token] for the import");
    expect(redactSecrets('{"key": "Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg"}')).toBe("{[removed: key assignment]}");
    expect(redactSecrets("key=a1b2c3d4e5f6a1b2c3d4")).toBe("[removed: key assignment]");
    expect(redactSecrets("curl --key 8f14e45fceea167a5a36dedd4bea2543 https://x")).toBe("curl --[removed: key assignment] https://x");
    expect(redactSecrets("{ key => '8f14e45fceea167a5a36dedd4bea2543' }")).toBe("{ [removed: key assignment] }");
    expect(redactSecrets("key -> 8f14e45fceea167a5a36dedd4bea2543")).toBe("[removed: key assignment]");
    // At the end of a sentence, the full stop stays and the key still goes.
    expect(redactSecrets("Use key=8f14e45fceea167a5a36dedd4bea2543.")).toBe("Use [removed: key assignment].");
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

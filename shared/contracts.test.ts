import { expect, test } from "vitest";
import { errorText } from "../client/errors";
import { parseLinkCommand, parseLinkUrl, parseTagNames, snapshotSettingsSchema } from "./contracts";

test("several tags split on commas, collapse duplicates, and refuse empty or too many", () => {
  expect(parseTagNames(" Auth ,billing, auth,  ")).toEqual(["Auth", "billing"]);
  expect(() => parseTagNames(" , ")).toThrow("A tag needs a name");
  expect(() => parseTagNames(Array.from({ length: 11 }, (_, i) => `t${i}`).join(","))).toThrow("at most 10 tags");
});

test("links accept web addresses only", () => {
  expect(parseLinkUrl(" https://example.com/a?b=1#c ")).toBe("https://example.com/a?b=1#c");
  expect(parseLinkUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "example.com", "https://", "https://exa mple.com"]) expect(() => parseLinkUrl(bad), bad).toThrow();
});

test("/tag-link takes the URL first and the rest as the tag", () => {
  expect(parseLinkCommand("https://example.com/spec  Auth   Rewrite")).toEqual({ url: "https://example.com/spec", tag: "Auth Rewrite" });
  expect(() => parseLinkCommand("https://example.com/spec")).toThrow("A tag needs a name");
  expect(() => parseLinkCommand("auth https://example.com")).toThrow("web address");
});

test("settings: 0 means the default, out-of-range values are invalid", () => {
  expect(snapshotSettingsSchema.parse({ terminalLines: 0 })).toEqual({ snapshotMaxChars: 40_000, turnsPerAgent: 6, terminalLines: 200 });
  expect(snapshotSettingsSchema.safeParse({ terminalLines: 9 }).success).toBe(false);
  expect(snapshotSettingsSchema.safeParse({ snapshotMaxChars: -1 }).success).toBe(false);
});

test("error toasts show the plugin's message without transport noise", () => {
  expect(errorText(new Error("Request failed: Contextualise settings are invalid (x). requestType=plugin.rpc.invoke.request code=handler_error"))).toBe("Contextualise settings are invalid (x).");
  expect(errorText(new Error('Request failed: [{"code":"custom","message":"A tag needs a name","path":["tags",0]}] requestType=plugin.rpc.invoke.request code=handler_error'))).toBe("A tag needs a name");
  expect(errorText("plain")).toBe("plain");
  expect(errorText(new Error("Request failed: Saved, but the confirmation row could not be added: Request failed: Unknown agent 'a1' requestType=agent.timeline.append.request code=handler_error requestType=plugin.rpc.invoke.request code=handler_error"))).toBe(
    "Saved, but the confirmation row could not be added: Unknown agent 'a1'",
  );
});

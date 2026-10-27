// What the user reads from a failed call: the plugin's own message, without the transport's
// "Request failed: ... requestType=... code=..." wrapping or a raw list of schema issues.
export function errorText(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/Request failed: /g, "").replace(/\s+requestType=\S+(\s+code=\S+)?/g, "");
  if (message.trimStart().startsWith("[")) {
    try {
      const issues: unknown = JSON.parse(message);
      if (Array.isArray(issues)) message = issues.map((issue) => String(Reflect.get(Object(issue), "message") ?? issue)).join("; ");
    } catch {
      // Not a JSON list after all; show it as it is.
    }
  }
  return message;
}

// For slash commands: Paseo shows a thrown error as a toast, so rethrow with a readable message.
export async function readable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(errorText(error));
  }
}

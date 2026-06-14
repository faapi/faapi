export type JsonParseResult = { success: true; data: unknown } | { success: false; error: string };

export function parseJsonBody(text: string): JsonParseResult {
  try {
    const data = JSON.parse(text);
    return { success: true, data };
  } catch {
    return { success: false, error: 'Invalid JSON body' };
  }
}

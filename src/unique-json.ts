/** Parse a wire document before its decoded members enter a signing or trust boundary. */
export function parseUniqueJson(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SyntaxError("Invalid JSON");
  }

  // Native parsing establishes valid JSON syntax. In that grammar only an
  // object member name is followed by a colon. Skip entire quoted strings so
  // punctuation inside a string never opens or closes a scope.
  const objects: (Set<string> | undefined)[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") objects.push(undefined);
    else if (char === "}") objects.pop();
    else if (char === '"') {
      const start = i;
      let escaped = false;
      for (i++; text[i] !== '"'; i++) {
        if (text[i] === "\\") {
          escaped = true;
          i++;
        }
      }
      let next = i + 1;
      while (next < text.length && text.charCodeAt(next) <= 32) next++;
      if (text[next] !== ":") continue;
      const key = escaped
        ? (JSON.parse(text.slice(start, i + 1)) as string)
        : text.slice(start + 1, i);
      const keys = (objects[objects.length - 1] ??= new Set<string>());
      if (keys.has(key)) throw new SyntaxError("Duplicate JSON member");
      keys.add(key);
    }
  }
  return value;
}

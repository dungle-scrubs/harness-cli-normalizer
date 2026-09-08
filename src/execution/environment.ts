/** Apply the spawn contract: an empty override removes the inherited key. */
export function mergeEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === "") delete result[key];
    else result[key] = value;
  }
  return result;
}

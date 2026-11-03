// The resolve hook that redirects "@cursor/sdk" to the scripted fake.
// Every other specifier resolves natively.
export async function resolve(specifier, context, next) {
  if (specifier === "@cursor/sdk") {
    return { shortCircuit: true, url: new URL("./fake-sdk.mjs", import.meta.url).href };
  }
  return next(specifier, context);
}

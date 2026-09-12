/** A live command can retain process ownership when a consumer disconnects.
 * Commands without owned cleanup retain the CLI's ordinary EPIPE behavior. */
let owner: ((error: Error) => void) | undefined;

export function ownOutputErrors(handler: (error: Error) => void): () => void {
  const previous = owner;
  owner = handler;
  return () => {
    if (owner === handler) owner = previous;
  };
}

export function handleOutputError(error: NodeJS.ErrnoException): void {
  if (owner) owner(error);
  else if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
}

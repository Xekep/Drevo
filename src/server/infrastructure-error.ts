export function isInfrastructureError(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return (
    typeof code === "string" &&
    ["ENOSPC", "EIO", "EMFILE", "ENOMEM"].includes(code)
  );
}

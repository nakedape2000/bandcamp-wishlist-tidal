export type WriteOutcome = "success" | "permanent_failure" | "unknown";

export function classifyWriteOutcome(status: number | null): WriteOutcome {
  if (status !== null && status >= 200 && status < 300) return "success";
  if (status !== null && status >= 400 && status < 500)
    return "permanent_failure";
  return "unknown";
}

export function shouldRefreshToken(
  status: number,
  alreadyRefreshed: boolean,
): boolean {
  return status === 401 && !alreadyRefreshed;
}

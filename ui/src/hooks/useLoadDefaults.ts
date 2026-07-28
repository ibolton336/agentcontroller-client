import { useCallback, useState } from "react";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";

interface SeedResult {
  seeded: number;
  existed: number;
  results: unknown[];
}

export function useLoadDefaults(api: ShimClient) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SeedResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seed = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.seedDefaults();
      setResult(r);
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [api]);

  return { loading, result, error, seed };
}

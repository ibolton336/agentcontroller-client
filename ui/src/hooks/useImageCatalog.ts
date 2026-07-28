import { useCallback, useEffect, useState } from "react";
import type { AgentImage } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";

export function useImageCatalog(api: ShimClient) {
  const [images, setImages] = useState<AgentImage[]>([]);
  const [source, setSource] = useState<"configmap" | "builtin" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { source: s, images: list } = await api.listImagesWithSource();
      setImages(list);
      setSource(s);
    } catch {
      setImages([]);
      setSource(null);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const findByImage = useCallback(
    (imageRef: string): AgentImage | undefined =>
      images.find((i) => i.image === imageRef),
    [images],
  );

  return { images, source, findByImage, refresh };
}

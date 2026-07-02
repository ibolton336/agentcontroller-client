/**
 * Local TCP listener that tunnels connections to a pod port via the
 * Kubernetes port-forward subresource — the programmatic equivalent of
 * `kubectl port-forward <pod> :4000`.
 *
 * Used when the client machine has no route to cluster service DNS (the
 * normal laptop-to-minikube case). Inside the cluster, or behind Hub's
 * stream proxy, connect to the service host directly instead.
 */
import * as net from "node:net";
import * as k8s from "@kubernetes/client-node";

export interface Tunnel {
  localPort: number;
  close(): void;
}

export async function openTunnel(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  targetPort: number,
): Promise<Tunnel> {
  const forward = new k8s.PortForward(kc);
  const server = net.createServer((socket) => {
    forward
      .portForward(namespace, podName, [targetPort], socket, null, socket)
      .catch((err) => {
        socket.destroy(err instanceof Error ? err : new Error(String(err)));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as net.AddressInfo;
  return {
    localPort: address.port,
    close: () => server.close(),
  };
}

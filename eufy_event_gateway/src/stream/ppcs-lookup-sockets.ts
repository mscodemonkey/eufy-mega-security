/**
 * Owns additional local UDP ports used by a PPCS cloud rendezvous attempt.
 *
 * The camera session owns the primary socket and handshake. This pool binds
 * seven additional ports, forwards their replies to that handshake, and closes
 * every losing port once the session adopts a winner or shuts down.
 */
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

/**
 * Keeps lookup ports alive until one completes the camera identity handshake.
 *
 * One camera session owns each pool. Probe binding failure is non-fatal and
 * removes only that probe. Session shutdown cancels pending binds and prevents
 * late replies from reaching the handshake.
 */
export class PpcsLookupSocketPool {
  readonly #sockets: Set<Socket>;
  readonly #bound = new Set<Socket>();
  #closed = false;
  #winner: Socket | null = null;

  constructor(
    primary: Socket,
    private readonly onMessage: (data: Buffer, info: RemoteInfo, socket: Socket) => void,
    private readonly onFailure: (error: Error) => void,
  ) {
    this.#sockets = new Set([primary]);
    this.#bound.add(primary);
  }

  /** Return all currently bound ports eligible for lookup registration. */
  get sockets(): readonly Socket[] {
    return [...this.#bound];
  }

  /** Bind the finite cloud-probe set, returning after each bind succeeds or fails. */
  async bindProbes(): Promise<void> {
    if (this.#closed) return;
    await Promise.all(Array.from({ length: 7 }, () => {
      const socket = createSocket("udp4");
      this.#sockets.add(socket);
      socket.on("message", (data, info) => {
        if (!this.#closed && this.#bound.has(socket)) this.onMessage(data, info, socket);
      });
      socket.on("error", (error) => {
        this.#bound.delete(socket);
        this.#sockets.delete(socket);
        this.#closeSocket(socket);
        if (this.#winner === socket && !this.#closed) this.onFailure(error);
      });
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          socket.off("close", finish);
          socket.off("error", finish);
          resolve();
        };
        socket.once("close", finish);
        socket.once("error", finish);
        socket.bind(0, () => {
          if (!this.#closed && this.#sockets.has(socket)) {
            this.#bound.add(socket);
            try {
              socket.setRecvBufferSize(1024 * 1024);
            } catch {

              // Some hosts cap the receive buffer below this requested size.
            }
          }
          finish();
        });
      });
    }));
  }

  /** Keep the bound handshake winner and close every other owned socket. */
  adopt(winner: Socket): boolean {
    if (this.#closed || !this.#bound.has(winner)) return false;
    for (const socket of this.#sockets) {
      if (socket !== winner) this.#closeSocket(socket);
    }
    this.#sockets.clear();
    this.#sockets.add(winner);
    this.#bound.clear();
    this.#bound.add(winner);
    this.#winner = winner;
    return true;
  }

  /** Release primary and probe ports, including probes whose bind is still pending. */
  close(): void {
    this.#closed = true;
    for (const socket of this.#sockets) this.#closeSocket(socket);
    this.#sockets.clear();
    this.#bound.clear();
  }

  #closeSocket(socket: Socket): void {
    socket.removeAllListeners("message");
    try {
      socket.close();
    } catch {

      // A failed bind can leave the socket already closed.
    }
  }
}

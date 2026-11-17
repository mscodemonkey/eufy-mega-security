/**
 * MCS wire-stream parser. The TLS stream is framed as:
 *   first packet:  [version:1][tag:1][varint length][protobuf]
 *   then each msg: [tag:1][varint length][protobuf]
 * Chunks arrive arbitrarily split, so we accumulate and re-enter as data lands.
 * Implements Google's MCS (mtalk) stream framing. Adapted from
 * mega-yfue/eufy-sdk (Apache-2.0). PushClient owns the connection lifetime and
 * consumes decoded messages and content-free framing diagnostics.
 */
import { EventEmitter } from "node:events";
import type { Reader, Type } from "protobufjs";
import { protobufjs } from "./protobuf.js";
import { mcsRoot } from "./proto.js";
import { MessageTag } from "./message-tags.js";
import type { McsMessage } from "./types.js";

enum State {
  VERSION_TAG_AND_SIZE = 0,
  TAG_AND_SIZE = 1,
  SIZE = 2,
  PROTO_BYTES = 3,
}

const TAG_TO_TYPE: Partial<Record<MessageTag, string>> = {
  [MessageTag.HeartbeatPing]: "mcs_proto.HeartbeatPing",
  [MessageTag.HeartbeatAck]: "mcs_proto.HeartbeatAck",
  [MessageTag.LoginRequest]: "mcs_proto.LoginRequest",
  [MessageTag.LoginResponse]: "mcs_proto.LoginResponse",
  [MessageTag.Close]: "mcs_proto.Close",
  [MessageTag.IqStanza]: "mcs_proto.IqStanza",
  [MessageTag.DataMessageStanza]: "mcs_proto.DataMessageStanza",
  [MessageTag.StreamErrorStanza]: "mcs_proto.StreamErrorStanza",
};

/** A content-free snapshot of this connection's unfinished frame, with no stanza or identity. */
export interface McsFramingSummary {

  /** Idle means no buffered header bytes; other states name the next framing boundary. */
  readonly state: "version" | "header" | "size" | "body" | "idle";
  readonly bufferedBytes: number;

  /** Body bytes still needed for a length-validated frame, zero outside a body wait. */
  readonly pendingBodyBytes: number;
}

/**
 * Reassembles protobuf MCS frames from one TLS connection's byte stream.
 *
 * PushClient owns and resets this parser on each reconnect. The parser emits
 * decoded wire stanzas; it does not interpret account notifications or own
 * credentials.
 */
export class McsParser extends EventEmitter {
  private static readonly MAX_BUFFER_BYTES = 4 * 1024 * 1024;
  private static readonly MAX_FRAME_BYTES = 2 * 1024 * 1024;
  private data = Buffer.alloc(0);
  private state = State.VERSION_TAG_AND_SIZE;
  private messageTag = 0;
  private messageSize = 0;
  private sizePacketSoFar = 0;

  /** Reset for a fresh connection. */
  reset(): void {
    this.data = Buffer.alloc(0);
    this.state = State.VERSION_TAG_AND_SIZE;
    this.messageTag = 0;
    this.messageSize = 0;
    this.sizePacketSoFar = 0;
  }

  /** Feed a chunk of TLS bytes. */
  handleData(chunk: Buffer): void {
    if (this.data.length + chunk.length > McsParser.MAX_BUFFER_BYTES) throw new Error("MCS receive buffer exceeded its limit");
    this.data = Buffer.concat([this.data, chunk]);
    this.waitForData();
  }

  /**
   * Observe an unfinished frame without consuming bytes or changing deadlines.
   * A partial frame does not establish its notification contents or explain why
   * the remaining bytes have not arrived. Reset retires all of this state.
   */
  diagnostic(): McsFramingSummary {
    const state = this.state === State.VERSION_TAG_AND_SIZE ? "version"
      : this.state === State.SIZE ? "size" : this.state === State.PROTO_BYTES ? "body"
        : this.data.length ? "header" : "idle";
    return { state, bufferedBytes: this.data.length,
      pendingBodyBytes: this.state === State.PROTO_BYTES ? Math.max(0, this.messageSize - this.data.length) : 0 };
  }

  private minBytesNeeded(): number {
    switch (this.state) {
      case State.VERSION_TAG_AND_SIZE:
        return 1 + 1 + 1;
      case State.TAG_AND_SIZE:
        return 1 + 1;
      case State.SIZE:
        return this.sizePacketSoFar + 1;
      case State.PROTO_BYTES:
        return this.messageSize;
    }
  }

  private waitForData(): void {
    if (this.data.length < this.minBytesNeeded()) return;
    switch (this.state) {
      case State.VERSION_TAG_AND_SIZE:
        this.onVersion();
        break;
      case State.TAG_AND_SIZE:
        this.onTag();
        break;
      case State.SIZE:
        this.onSize();
        break;
      case State.PROTO_BYTES:
        this.onBytes();
        break;
    }
  }

  private onVersion(): void {
    const version = this.data.readInt8(0);
    this.data = this.data.subarray(1);
    if (version < 38) throw new Error(`MCS: wrong protocol version ${version}`);
    this.onTag();
  }

  private onTag(): void {
    this.messageTag = this.data.readInt8(0);
    this.data = this.data.subarray(1);
    this.onSize();
  }

  private onSize(): void {
    const reader: Reader = protobufjs().Reader.create(this.data);
    let incomplete = false;
    try {
      this.messageSize = reader.int32();
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("index out of range:")) incomplete = true;
      else throw e;
    }
    if (incomplete) {
      this.sizePacketSoFar = reader.pos;
      this.state = State.SIZE;
      this.waitForData();
      return;
    }
    if (this.messageSize < 0 || this.messageSize > McsParser.MAX_FRAME_BYTES) throw new Error("MCS frame size is invalid");
    this.data = this.data.subarray(reader.pos);
    this.sizePacketSoFar = 0;
    if (this.messageSize > 0) {
      this.state = State.PROTO_BYTES;
      this.waitForData();
    } else {
      this.onBytes();
    }
  }

  private onBytes(): void {
    if (this.messageSize === 0) {
      this.emitMessage({ tag: this.messageTag, object: {} });
      this.next();
      return;
    }
    if (this.data.length < this.messageSize) {
      this.state = State.PROTO_BYTES;
      return;
    }
    const buf = this.data.subarray(0, this.messageSize);
    this.data = this.data.subarray(this.messageSize);
    const typeName = TAG_TO_TYPE[this.messageTag as MessageTag];
    let object: any = {};
    if (typeName) {
      const type: Type = mcsRoot().lookupType(typeName);
      object = type.toObject(type.decode(buf), { longs: String, enums: String, bytes: Buffer });
    }
    this.emitMessage({ tag: this.messageTag, object });
    this.next();
  }

  private next(): void {
    this.state = State.TAG_AND_SIZE;
    this.waitForData();
  }

  private emitMessage(m: McsMessage): void {
    this.emit("message", m);
  }
}

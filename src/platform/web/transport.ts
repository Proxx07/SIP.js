import { EventEmitter } from "events";

import { Transport as TransportDefinition } from "../../api";
import { Grammar, Logger } from "../../core";
import { TransportOptions } from "./transport-options";

/**
 * FIXME: See below.
 * @internal
 */
interface WebSocketServer {
  /**
   * FIXME
   * This "scheme" currently dictates what gets written into the
   * the Via header in ClientTransaction and InviteClientTransaction.
   */
  scheme: string;
  /**
   * FIXME
   * This "sipUri" currently dictates what gets set in the route set
   * of an outgoing request in OutgoingRequestMessage if the UserAgent
   * is configured with preloaded route set is enabled.
   */
  sipUri: string;
  /**
   * The URI of the WebSocket Server.
   */
  wsUri: string;
  /**
   * FIXME
   * This "weight" is used in order servers to try.
   */
  weight: number;
  /**
   * FIXME
   * Used to keep track if this server is in an error state.
   */
  isError: boolean;
}

/**
 * Legacy Transport.
 * @remarks
 * Abstract transport layer base class.
 * @public
 */
abstract class LegacyTransport extends EventEmitter implements TransportDefinition {
  /**
   * FIXME: This needs to be reworked.
   * Some transport configuration which is controlling core behavior.
   * @internal
   */
  public server?: {
    // This "scheme" currently dictates what gets written into the
    // the Via header in ClientTransaction and InviteClientTransaction.
    scheme?: string;
    // This "sipUri" currently dictates what gets set in the route set
    // of an outgoing request in OutgoingRequestMessage if the UserAgent
    // is configured with preloaded route set is enabled.
    sipUri?: string;
  };

  /**
   * The protocol.
   *
   * @remarks
   * Formatted as defined for the Via header sent-protocol transport.
   * https://tools.ietf.org/html/rfc3261#section-20.42
   */
  public get protocol(): string {
    return this.server && this.server.scheme ? this.server.scheme : "WSS";
  }

  protected logger: Logger;

  /**
   * Constructor
   * @param logger - Logger.
   * @param options - Options bucket. Deprecated.
   */
  constructor(logger: Logger, options?: any) {
    super();
    this.logger = logger;
  }

  /**
   * Returns the promise designated by the child layer then emits a connected event.
   * Automatically emits an event upon resolution, unless overrideEvent is set. If you
   * override the event in this fashion, you should emit it in your implementation of connectPromise
   * @param options - Options bucket.
   */
  public connect(options: any = {}): Promise<void> {
    return this.connectPromise(options).then((data: any) => {
      if (!data.overrideEvent) {
        this.emit("connected");
      }
    });
  }

  /**
   * Returns true if the transport is connected
   */
  public abstract isConnected(): boolean;

  /**
   * Sends a message then emits a 'messageSent' event. Automatically emits an
   * event upon resolution, unless data.overrideEvent is set. If you override
   * the event in this fashion, you should emit it in your implementation of sendPromise
   * Rejects with an Error if message fails to send.
   * @param message - Message.
   * @param options - Options bucket.
   */
  public send(message: string, options: any = {}): Promise<void> {
    // Error handling is independent of whether the message was a request or
    // response.
    //
    // If the transport user asks for a message to be sent over an
    // unreliable transport, and the result is an ICMP error, the behavior
    // depends on the type of ICMP error.  Host, network, port or protocol
    // unreachable errors, or parameter problem errors SHOULD cause the
    // transport layer to inform the transport user of a failure in sending.
    // Source quench and TTL exceeded ICMP errors SHOULD be ignored.
    //
    // If the transport user asks for a request to be sent over a reliable
    // transport, and the result is a connection failure, the transport
    // layer SHOULD inform the transport user of a failure in sending.
    // https://tools.ietf.org/html/rfc3261#section-18.4
    return this.sendPromise(message).then((result) => {
      if (!result.overrideEvent) {
        this.emit("messageSent", result.msg);
      }
    });
  }

  /**
   * Returns the promise designated by the child layer then emits a
   * disconnected event. Automatically emits an event upon resolution,
   * unless overrideEvent is set. If you override the event in this fashion,
   * you should emit it in your implementation of disconnectPromise
   * @param options - Options bucket
   */
  public disconnect(options: any = {}): Promise<void> {
    return this.disconnectPromise(options).then((data: any) => {
      if (!data.overrideEvent) {
        this.emit("disconnected");
      }
    });
  }

  public afterConnected(callback: () => void): void {
    if (this.isConnected()) {
      callback();
    } else {
      this.once("connected", callback);
    }
  }

  /**
   * Returns a promise which resolves once the UA is connected. DEPRECATION WARNING: just use afterConnected()
   */
  public waitForConnected(): Promise<void> {
    // tslint:disable-next-line:no-console
    console.warn("DEPRECATION WARNING Transport.waitForConnected(): use afterConnected() instead");
    return new Promise((resolve) => {
      this.afterConnected(resolve);
    });
  }
  /**
   * Called by connect, must return a promise
   * promise must resolve to an object. object supports 1 parameter: overrideEvent - Boolean
   * @param options - Options bucket.
   */
  protected abstract connectPromise(options: any): Promise<any>;

  /**
   * Called by send.
   * @param message - Message.
   * @param options - Options bucket.
   */
  protected abstract sendPromise(message: string, options?: any): Promise<{ msg: string, overrideEvent?: boolean }>;

  /**
   * Called by disconnect, must return a promise
   * promise must resolve to an object. object supports 1 parameter: overrideEvent - Boolean
   * @param options - Options bucket.
   */
  protected abstract disconnectPromise(options: any): Promise<any>;

  /**
   * To be called when a message is received
   * @param e - Event
   */
  protected abstract onMessage(e: any): void;
}

export enum TransportStatus {
  STATUS_CONNECTING,
  STATUS_OPEN,
  STATUS_CLOSING,
  STATUS_CLOSED
}

/**
 * Transport
 */
// tslint:disable-next-line:max-classes-per-file
export class Transport extends LegacyTransport {
  public static readonly C = TransportStatus;

  private static defaultOptions: Required<TransportOptions> = {
    wsServers: [],
    connectionTimeout: 5,
    maxReconnectionAttempts: 3,
    reconnectionTimeout: 4,
    keepAliveInterval: 0,
    keepAliveDebounce: 10,
    traceSip: true
  };

  public server: WebSocketServer;
  public ws: WebSocket | undefined;

  private servers: Array<WebSocketServer> = [];

  private connectionPromise: Promise<any> | undefined;
  private connectDeferredResolve: ((obj: any) => void) | undefined;
  private connectDeferredReject: ((obj: any) => void) | undefined;
  private connectionTimeout: any | undefined;

  private disconnectionPromise: Promise<any> | undefined;
  private disconnectDeferredResolve: ((obj: any) => void) | undefined;

  private reconnectionAttempts: number = 0;
  private reconnectTimer: any | undefined;

  // Keep alive
  private keepAliveInterval: any | undefined;
  private keepAliveDebounceTimeout: any | undefined;

  private status: TransportStatus = TransportStatus.STATUS_CONNECTING;
  private configuration: Required<TransportOptions>;
  private boundOnOpen: any;
  private boundOnMessage: any;
  private boundOnClose: any;
  private boundOnError: any;

  constructor(logger: Logger, options: TransportOptions) {
    super(logger);

    // initialize configuration
    this.configuration = {
      // start with the default option values
      ...Transport.defaultOptions,
      // apply any options passed in via the constructor
      ...options
    };

    // initialize WebSocket servers
    let urls = options.wsServers;
    if (typeof urls === "string") {
      urls = [urls];
    }
    for (const url of urls) {
      const parsed: any | -1 = Grammar.parse(url, "absoluteURI");
      if (parsed === -1) {
        this.logger.error(`Invalid WebSocket Server URL "${url}"`);
        throw new Error("Invalid WebSocket Server URL");
      }
      if (["wss", "ws", "udp"].indexOf(parsed.scheme) < 0) {
        this.logger.error(`Invalid scheme in WebSocket Server URL "${url}"`);
        throw new Error("Invalid scheme in WebSocket Server URL");
      }
      const scheme = parsed.scheme.toUpperCase();
      const sipUri = "<sip:" + parsed.host +
        (parsed.port ? ":" + parsed.port : "") + ";transport=" + parsed.scheme.replace(/^wss$/i, "ws") + ";lr>";
      const wsUri = url;
      const weight = 0;
      const isError = false;
      this.servers.push({
        scheme,
        sipUri,
        wsUri,
        weight,
        isError
      });
    }
    if (this.servers.length === 0) {
      throw new Error("No WebSocket server.");
    }
    this.server = this.servers[0];
  }

  /**
   * @returns {Boolean}
   */
  public isConnected(): boolean {
    return this.status === TransportStatus.STATUS_OPEN;
  }

  /**
   * Send a message.
   * @param message - Outgoing message.
   * @param options - Options bucket.
   */
  protected sendPromise(message: string, options: any = {}): Promise<{msg: string}> {
    if (this.ws === undefined) {
      this.onError("unable to send message - WebSocket undefined");
      return Promise.reject(new Error("WebSocket undefined."));
    }

    // FIXME: This check is likely not necessary as WebSocket.send() will
    // throw INVALID_STATE_ERR if the connection is not currently open
    // which could happen regardless of what we thing the state is.
    if (!this.statusAssert(TransportStatus.STATUS_OPEN, options.force)) {
      this.onError("unable to send message - WebSocket not open");
      return Promise.reject(new Error("WebSocket not open."));
    }

    if (this.configuration.traceSip === true) {
      this.logger.log("sending WebSocket message:\n\n" + message + "\n");
    }

    // WebSocket.send() can throw.
    // https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/send
    try {
      this.ws.send(message);
    } catch (error) {
      if (error instanceof error) {
        Promise.reject(error);
      }
      return Promise.reject(new Error("Failed to send message."));
    }

    return Promise.resolve({ msg: message });
  }

  /**
   * Disconnect socket.
   */
  protected disconnectPromise(options: any = {}): Promise<any> {
    if (this.disconnectionPromise) { // Already disconnecting. Just return this.
      return this.disconnectionPromise;
    }
    options.code = options.code || 1000;

    if (!this.statusTransition(TransportStatus.STATUS_CLOSING, options.force)) {
      if (this.status === TransportStatus.STATUS_CLOSED) { // Websocket is already closed
        return Promise.resolve({overrideEvent: true});
      } else if (this.connectionPromise) { // Websocket is connecting, cannot move to disconneting yet
        return this.connectionPromise.then(() => Promise.reject("The websocket did not disconnect"))
        .catch(() => Promise.resolve({overrideEvent: true}));
      } else {
        // Cannot move to disconnecting, but not in connecting state.
        return Promise.reject("The websocket did not disconnect");
      }
    }
    this.emit("disconnecting");
    this.disconnectionPromise = new Promise((resolve, reject) => {
      this.disconnectDeferredResolve = resolve;

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }

      if (this.ws) {
        this.stopSendingKeepAlives();

        this.logger.log("closing WebSocket " + this.server.wsUri);
        this.ws.close(options.code, options.reason);
      } else {
        reject("Attempted to disconnect but the websocket doesn't exist");
      }
    });

    return this.disconnectionPromise;
  }

  /**
   * Connect socket.
   */
  protected connectPromise(options: any = {}) {
    if (this.status === TransportStatus.STATUS_CLOSING && !options.force) {
      return Promise.reject("WebSocket " + this.server.wsUri + " is closing");
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    this.server = this.server || this.getNextWsServer(options.force);

    this.connectionPromise = new Promise((resolve, reject) => {
      if ((this.status === TransportStatus.STATUS_OPEN || this.status === TransportStatus.STATUS_CLOSING)
        && !options.force) {
        this.logger.warn("WebSocket " + this.server.wsUri + " is already connected");
        reject("Failed status check - attempted to open a connection but already open/closing");
        return;
      }

      this.connectDeferredResolve = resolve;
      this.connectDeferredReject = reject;

      this.status = TransportStatus.STATUS_CONNECTING;
      this.emit("connecting");
      this.logger.log("connecting to WebSocket " + this.server.wsUri);
      this.disposeWs();
      try {
        this.ws = new WebSocket(this.server.wsUri, "sip");
      } catch (e) {
        this.ws = undefined;
        this.statusTransition(TransportStatus.STATUS_CLOSED, true);
        this.onError("error connecting to WebSocket " + this.server.wsUri + ":" + e);
        reject("Failed to create a websocket");
        this.connectDeferredResolve = undefined;
        this.connectDeferredReject = undefined;
        return;
      }

      if (!this.ws) {
        reject("Unexpected instance websocket not set");
        this.connectDeferredResolve = undefined;
        this.connectDeferredReject = undefined;
        return;
      }

      this.connectionTimeout = setTimeout(() => {
        this.statusTransition(TransportStatus.STATUS_CLOSED);
        this.logger.warn("took too long to connect - exceeded time set in configuration.connectionTimeout: " +
          this.configuration.connectionTimeout + "s");
        this.emit("disconnected", {code: 1000});
        this.connectionPromise = undefined;
        reject("Connection timeout");
        this.connectDeferredResolve = undefined;
        this.connectDeferredReject = undefined;
        const ws = this.ws;
        this.disposeWs();
        if (ws) {
          ws.close(1000);
        }
      }, this.configuration.connectionTimeout * 1000);

      this.boundOnOpen = this.onOpen.bind(this);
      this.boundOnMessage = this.onMessage.bind(this);
      this.boundOnClose = this.onClose.bind(this);
      this.boundOnError = this.onWebsocketError.bind(this);

      this.ws.addEventListener("open", this.boundOnOpen);
      this.ws.addEventListener("message", this.boundOnMessage);
      this.ws.addEventListener("close", this.boundOnClose);
      this.ws.addEventListener("error", this.boundOnError);
    });

    return this.connectionPromise;
  }

  /**
   * @event
   * @param {event} e
   */
  protected onMessage(e: any): void {
    const data: any  = e.data;
    let finishedData: string;
    // CRLF Keep Alive response from server. Clear our keep alive timeout.
    if (/^(\r\n)+$/.test(data)) {
      this.clearKeepAliveTimeout();

      if (this.configuration.traceSip === true) {
        this.logger.log("received WebSocket message with CRLF Keep Alive response");
      }
      return;
    } else if (!data) {
      this.logger.warn("received empty message, message discarded");
      return;
    } else if (typeof data !== "string") { // WebSocket binary message.
      try {
        // the UInt8Data was here prior to types, and doesn't check
        finishedData = String.fromCharCode.apply(null, (new Uint8Array(data) as unknown as Array<number>));
      } catch (err) {
        this.logger.warn("received WebSocket binary message failed to be converted into string, message discarded");
        return;
      }

      if (this.configuration.traceSip === true) {
        this.logger.log("received WebSocket binary message:\n\n" + data + "\n");
      }
    } else { // WebSocket text message.
      if (this.configuration.traceSip === true) {
        this.logger.log("received WebSocket text message:\n\n" + data + "\n");
      }
      finishedData = data;
    }

    this.emit("message", finishedData);
  }

  // Transport Event Handlers

  /**
   * @event
   * @param {event} e
   */
  private onOpen(): void  {
    if (this.status === TransportStatus.STATUS_CLOSED) { // Indicated that the transport thinks the ws is dead already
      const ws = this.ws;
      this.disposeWs();
      if (ws) {
        ws.close(1000);
      }
      return;
    }
    this.statusTransition(TransportStatus.STATUS_OPEN, true);
    this.emit("connected");
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }

    this.logger.log("WebSocket " + this.server.wsUri + " connected");

    // Clear reconnectTimer since we are not disconnected
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // Reset reconnectionAttempts
    this.reconnectionAttempts = 0;

    // Reset disconnection promise so we can disconnect from a fresh state
    this.disconnectionPromise = undefined;
    this.disconnectDeferredResolve = undefined;

    // Start sending keep-alives
    this.startSendingKeepAlives();

    if (this.connectDeferredResolve) {
      this.connectDeferredResolve({overrideEvent: true});
      this.connectDeferredResolve = undefined;
      this.connectDeferredReject = undefined;
    } else {
      this.logger.warn("Unexpected websocket.onOpen with no connectDeferredResolve");
    }
  }

  /**
   * @event
   * @param {event} e
   */
  private onClose(e: any): void {
    this.logger.log("WebSocket disconnected (code: " + e.code + (e.reason ? "| reason: " + e.reason : "") + ")");

    if (this.status !== TransportStatus.STATUS_CLOSING) {
      this.logger.warn("WebSocket closed without SIP.js requesting it");
      this.emit("transportError");
    }

    this.stopSendingKeepAlives();

    // Clean up connection variables so we can connect again from a fresh state
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    if (this.connectDeferredReject) {
      this.connectDeferredReject("Websocket Closed");
    }
    this.connectionTimeout = undefined;
    this.connectionPromise = undefined;
    this.connectDeferredResolve = undefined;
    this.connectDeferredReject = undefined;

    // Check whether the user requested to close.
    if (this.disconnectDeferredResolve) {
      this.disconnectDeferredResolve({ overrideEvent: true });
      this.statusTransition(TransportStatus.STATUS_CLOSED);
      this.disconnectDeferredResolve = undefined;
      return;
    }

    this.statusTransition(TransportStatus.STATUS_CLOSED, true);
    this.emit("disconnected", {code: e.code, reason: e.reason});

    this.disposeWs();
    this.reconnect();
  }

  /**
   * Removes event listeners and clears the instance ws
   */
  private disposeWs(): void {
    if (this.ws) {
      this.ws.removeEventListener("open", this.boundOnOpen);
      this.ws.removeEventListener("message", this.boundOnMessage);
      this.ws.removeEventListener("close", this.boundOnClose);
      this.ws.removeEventListener("error", this.boundOnError);
      this.ws = undefined;
    }
  }

  /**
   * @event
   * @param {string} e
   */
  private onError(e: any): void {
    this.logger.warn("Transport error: " + e);
    this.emit("transportError");
  }

  /**
   * @event
   * @private
   */
  private onWebsocketError(): void {
    this.onError("The Websocket had an error");
  }

  /**
   * Reconnection attempt logic.
   */
  private reconnect(): void {
    if (this.reconnectionAttempts > 0) {
      this.logger.log("Reconnection attempt " + this.reconnectionAttempts + " failed");
    }

    if (this.noAvailableServers()) {
      this.logger.warn("attempted to get next ws server but there are no available ws servers left");
      this.logger.warn("no available ws servers left - going to closed state");
      this.statusTransition(TransportStatus.STATUS_CLOSED, true);
      this.emit("closed");
      this.resetServerErrorStatus();
      return;
    }

    if (this.isConnected()) {
      this.logger.warn("attempted to reconnect while connected - forcing disconnect");
      this.disconnect({force: true});
    }

    this.reconnectionAttempts += 1;

    if (this.reconnectionAttempts > this.configuration.maxReconnectionAttempts) {
      this.logger.warn("maximum reconnection attempts for WebSocket " + this.server.wsUri);
      this.logger.log("transport " + this.server.wsUri + " failed | connection state set to 'error'");
      this.server.isError = true;
      this.emit("transportError");
      if (!this.noAvailableServers()) {
        this.server = this.getNextWsServer();
      }
      // When there are no available servers, the reconnect function ends on the next recursive call
      // after checking for no available servers again.
      this.reconnectionAttempts = 0;
      this.reconnect();
    } else {
      this.logger.log("trying to reconnect to WebSocket " +
        this.server.wsUri + " (reconnection attempt " + this.reconnectionAttempts + ")");
      this.reconnectTimer = setTimeout(() => {
        this.connect();
        this.reconnectTimer = undefined;
      }, (this.reconnectionAttempts === 1) ? 0 : this.configuration.reconnectionTimeout * 1000);
    }
  }

  /**
   * Resets the error state of all servers in the configuration
   */
  private resetServerErrorStatus(): void {
    for (const websocket of this.servers) {
      websocket.isError = false;
    }
  }

  /**
   * Retrieve the next server to which connect.
   * @param {Boolean} force allows bypass of server error status checking
   * @returns {Object} WsServer
   */
  private getNextWsServer(force: boolean = false): WebSocketServer {
    if (this.noAvailableServers()) {
      this.logger.warn("attempted to get next ws server but there are no available ws servers left");
      throw new Error("Attempted to get next ws server, but there are no available ws servers left.");
    }
    // Order servers by weight
    let candidates: Array<WebSocketServer> = [];

    for (const server of this.servers) {
      if (server.isError && !force) {
        continue;
      } else if (candidates.length === 0) {
        candidates.push(server);
      } else if (server.weight > candidates[0].weight) {
        candidates = [server];
      } else if (server.weight === candidates[0].weight) {
        candidates.push(server);
      }
    }

    const idx: number = Math.floor(Math.random() * candidates.length);
    return candidates[idx];
  }

  /**
   * Checks all configuration servers, returns true if all of them have isError: true and false otherwise
   * @returns {Boolean}
   */
  private noAvailableServers(): boolean {
    for (const server of this.servers) {
      if (!server.isError) {
        return false;
      }
    }
    return true;
  }

  // ==============================
  // KeepAlive Stuff
  // ==============================

  /**
   * Send a keep-alive (a double-CRLF sequence).
   * @returns {Boolean}
   */
  private sendKeepAlive(): Promise<any> | void {
    if (this.keepAliveDebounceTimeout) {
      // We already have an outstanding keep alive, do not send another.
      return;
    }

    this.keepAliveDebounceTimeout = setTimeout(() => {
      this.emit("keepAliveDebounceTimeout");
      this.clearKeepAliveTimeout();
    }, this.configuration.keepAliveDebounce * 1000);

    return this.send("\r\n\r\n");
  }

  private clearKeepAliveTimeout(): void {
    if (this.keepAliveDebounceTimeout) {
      clearTimeout(this.keepAliveDebounceTimeout);
    }
    this.keepAliveDebounceTimeout = undefined;
  }

  /**
   * Start sending keep-alives.
   */
  private startSendingKeepAlives(): void {
    // Compute an amount of time in seconds to wait before sending another keep-alive.
    const computeKeepAliveTimeout = (upperBound: number): number => {
      const lowerBound: number = upperBound * 0.8;
      return 1000 * (Math.random() * (upperBound - lowerBound) + lowerBound);
    };

    if (this.configuration.keepAliveInterval && !this.keepAliveInterval) {
      this.keepAliveInterval = setInterval(() => {
        this.sendKeepAlive();
        this.startSendingKeepAlives();
      }, computeKeepAliveTimeout(this.configuration.keepAliveInterval));
    }
  }

  /**
   * Stop sending keep-alives.
   */
  private stopSendingKeepAlives(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }
    if (this.keepAliveDebounceTimeout) {
      clearTimeout(this.keepAliveDebounceTimeout);
    }
    this.keepAliveInterval = undefined;
    this.keepAliveDebounceTimeout = undefined;
  }

  // ==============================
  // Status Stuff
  // ==============================

  /**
   * Checks given status against instance current status. Returns true if they match
   * @param {Number} status
   * @param {Boolean} [force]
   * @returns {Boolean}
   */
  private statusAssert(status: TransportStatus, force: boolean): boolean {
    if (status === this.status) {
      return true;
    } else {
      if (force) {
        this.logger.warn("Attempted to assert " +
          Object.keys(TransportStatus)[this.status] + " as " +
          Object.keys(TransportStatus)[status] + "- continuing with option: 'force'");
        return true;
      } else {
        this.logger.warn("Tried to assert " +
        Object.keys(TransportStatus)[status] + " but is currently " +
        Object.keys(TransportStatus)[this.status]);
        return false;
      }
    }
  }

  /**
   * Transitions the status. Checks for legal transition via assertion beforehand
   * @param {Number} status
   * @param {Boolean} [force]
   * @returns {Boolean}
   */
  private statusTransition(status: TransportStatus, force: boolean = false): boolean {
    this.logger.log("Attempting to transition status from " +
      Object.keys(TransportStatus)[this.status] + " to " +
      Object.keys(TransportStatus)[status]);
    if ((status === TransportStatus.STATUS_CONNECTING && this.statusAssert(TransportStatus.STATUS_CLOSED, force)) ||
        (status === TransportStatus.STATUS_OPEN && this.statusAssert(TransportStatus.STATUS_CONNECTING, force)) ||
        (status === TransportStatus.STATUS_CLOSING && this.statusAssert(TransportStatus.STATUS_OPEN, force))    ||
        (status === TransportStatus.STATUS_CLOSED)) {
      this.status = status;
      return true;
    } else {
      this.logger.warn("Status transition failed - result: no-op - reason:" +
        " either gave an nonexistent status or attempted illegal transition");
      return false;
    }
  }
}

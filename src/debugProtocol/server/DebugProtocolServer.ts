import { EventEmitter } from 'eventemitter3';
import * as Net from 'net';
import { SmartBuffer } from 'smart-buffer';
import { ActionQueue } from '../../managers/ActionQueue';
import { HandshakeRequestV3 } from '../requests/HandshakeRequestV3';
import type { ProtocolRequest } from '../requests/ProtocolRequest';
import { HandshakeResponseV3 } from '../responses';
import type { ProtocolResponse } from '../responses/ProtocolResponse';
import PluginInterface from './PluginInterface';
import type { ProtocolPlugin } from './ProtocolPlugin';

export const DEBUGGER_MAGIC = 'bsdebug';

/**
 * A class that emulates the way a Roku's DebugProtocol debug session/server works. This is mostly useful for unit testing,
 * but might eventually be helpful for an off-device emulator as well
 */
export class DebugProtocolServer {
    constructor(
        public options: DebugProtocolServerOptions
    ) {

    }

    /**
     * Indicates whether the client has sent the magic string to kick off the debug session.
     */
    private isHandshakeComplete = false;

    private buffer = Buffer.alloc(0);

    /**
     * The server
     */
    private server: Net.Server;
    /**
     * Once a client connects, this is a reference to that client
     */
    private client: Net.Socket;

    /**
     * A collection of plugins that can interact with the server at lifecycle points
     */
    public plugins = new PluginInterface<ProtocolPlugin>();

    /**
     * A queue for processing the incoming buffer, every transmission at a time
     */
    private bufferQueue = new ActionQueue();


    /**
     * Run the server. This opens a socket and listens for a connection.
     * The promise resolves when the server has started listening. It does NOT wait for a client to connect
     */
    public start() {
        return new Promise<void>((resolve) => {
            this.server = new Net.Server({});
            //Roku only allows 1 connection, so we should too.
            this.server.maxConnections = 1;

            //whenever a client makes a connection
            // eslint-disable-next-line @typescript-eslint/no-misused-promises
            this.server.on('connection', async (socket: Net.Socket) => {
                const event = await this.plugins.emit('onClientConnected', {
                    server: this,
                    client: socket
                });
                this.client = event.client;

                //anytime we receive incoming data from the client
                this.client.on('data', (data) => {
                    //queue up processing the new data, chunk by chunk
                    void this.bufferQueue.run(() => {
                        this.buffer = Buffer.concat([this.buffer, data]);
                        void this.process();
                        return true;
                    });
                });
            });

            this.server.listen({
                port: this.options.controllerPort ?? 8081,
                hostName: this.options.host ?? '0.0.0.0'
            }, resolve);
        });
    }

    public async stop() {
        //close the client socket
        await new Promise<void>((resolve) => {
            this.client.end(resolve);
        }).catch(() => { });

        //now close the server
        return new Promise<void>((resolve, reject) => {
            this.server.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    private async process() {
        let request: ProtocolRequest;

        //handle the handshake flow
        if (!this.isHandshakeComplete) {
            //the client should send a magic string to kick off the debugger
            const request = new HandshakeRequestV3(this.buffer);
            if (request.success && request.data.magic === this.magic) {
                //send the handshake response

                //the handshake has been completed.
                this.isHandshakeComplete = true;

                await this.sendResponse(new HandshakeResponseV3({
                    magic: this.magic,
                    majorVersion: 3,
                    minorVersion: 1,
                    patchVersion: 0,
                    //TODO update this to an actual date from the device
                    revisionTimeStamp: new Date(2022, 1, 1)
                }));
            }
        } else {
            //at this point, there is an active debug session. The plugin must provide us all the real-world data
            const requestEvent = await this.plugins.emit('provideRequest', {
                server: this,
                buffer: this.buffer,
                request: undefined
            });

            //assume the plugin gave back a new buffer with the processed data removed
            this.buffer = requestEvent.buffer;

            //now ask the plugin to provide a response for the given request
            const responseEvent = await this.plugins.emit('provideResponse', {
                server: this,
                request: request,
                response: undefined
            });

            await this.sendResponse(responseEvent.response);
        }
    }

    /**
     * Send a response from the server to the client. This involves writing the response buffer to the client socket
     */
    private async sendResponse(response: ProtocolResponse) {
        await this.plugins.emit('beforeSendResponse', {
            server: this,
            response: response
        });

        this.client.write(response.toBuffer());

        await this.plugins.emit('afterSendResponse', {
            server: this,
            response: response
        });
    }

    /**
     * An event emitter used for all of the events this server emitts
     */
    private emitter = new EventEmitter();

    public on<T = { response: Response }>(eventName: 'before-send-response', callback: (event: T) => void);
    public on<T = { response: Response }>(eventName: 'after-send-response', callback: (event: T) => void);
    public on<T = { client: Net.Socket }>(eventName: 'client-connected', callback: (event: T) => void);
    public on<T = any>(eventName: string, callback: (data: T) => void)
    public on<T = any>(eventName: string, callback: (data: T) => void) {
        this.emitter.on(eventName, callback);
        return () => {
            this.emitter?.removeListener(eventName, callback);
        };
    }

    /**
     * Subscribe to an event exactly one time. This will fire the very next time an event happens,
     * and then immediately unsubscribe
     */
    public once<T>(eventName: string): Promise<T> {
        return new Promise<T>((resolve) => {
            const off = this.on<T>(eventName, (event) => {
                off();
                resolve(event);
            });
        });
    }

    public emit<T = { response: Response }>(eventName: 'before-send-response', event: T): T;
    public emit<T = { response: Response }>(eventName: 'after-send-response', event: T): T;
    public emit<T = { client: Net.Socket }>(eventName: 'client-connected', event: T): T;
    public emit<T>(eventName: string, event: any): T {
        this.emitter?.emit(eventName, event);
        return event;
    }

    /**
     * The magic string used to kick off the debug session.
     * @default "bsdebug"
     */
    private get magic() {
        return this.options.magic ?? DEBUGGER_MAGIC;
    }
}

export interface DebugProtocolServerOptions {
    /**
     * The magic that is sent as part of the handshake
     */
    magic?: string;
    /**
     * The port to use for the primary communication between this server and a client
     */
    controllerPort?: number;
    /**
     * A specific host to listen on. If not specified, all hosts are used
     */
    host?: string;
}

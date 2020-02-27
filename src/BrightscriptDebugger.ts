import * as rokuDeploy from 'roku-deploy';
import * as Net from 'net';

// The port number and hostname of the server.
import { DebuggerRequestResponse } from './DebuggerRequestResponse';
import { DebuggerVariableRequestResponse } from './DebuggerVariableRequestResponse';
import { DebuggerStacktraceRequestResponse } from './DebuggerStacktraceRequestResponse';
import { DebuggerThreadsRequestResponse } from './DebuggerThreadsRequestResponse';
import { DebuggerUpdateThreads } from './DebuggerUpdateThreads';
import { DebuggerUpdateUndefined } from './DebuggerUpdateUndefined';
import { DebuggerUpdateConnectIoPort } from './DebuggerUpdateConnectIoPort';
import { DebuggerHandshake } from './DebuggerHandshake';
import { COMMANDS, STEP_TYPE } from './Constants';
import { SmartBuffer } from 'smart-buffer';
import { util } from './util';

const CONTROLLER_PORT = 8081;
const DEBUGGER_MAGIC = 'bsdebug'; // 64-bit = [b'bsdebug\0' little-endian]

export class BrightscriptDebugger {
  public scriptTitle: string;
  public host: string;
  public handshakeComplete = false;
  public protocolVersion = [];
  public primaryThread: number;
  public stackFrameIndex: number;

  private CONTROLLER_CLIENT: Net.Socket;
  private unhandledData: Buffer;
  private firstRunContinueFired = false;
  private stopped = false;
  private totalRequests = 0;
  private activeRequests = {};

  public async start(applicationDeployConfig: any) {
    console.log('start - SocketDebugger');
    const debugSetupEnd = 'total socket debugger setup time';
    console.time(debugSetupEnd);

    // Enable the remoteDebug option.
    applicationDeployConfig.remoteDebug = true;

    this.host = applicationDeployConfig.host;

    await rokuDeploy.deploy(applicationDeployConfig);

    (async () => {
      // Create a new TCP client.`
      this.CONTROLLER_CLIENT = new Net.Socket();
      // Send a connection request to the server.
      console.log('port', CONTROLLER_PORT, 'host', applicationDeployConfig.host);
      this.CONTROLLER_CLIENT.connect({ port: CONTROLLER_PORT, host: applicationDeployConfig.host }, () => {
        // If there is no error, the server has accepted the request and created a new
        // socket dedicated to us.
        console.log('TCP connection established with the server.');

        // The client can also receive data from the server by reading from its socket.
        // The client can now send data to the server by writing to its socket.
        let buffer = new SmartBuffer({ size: Buffer.byteLength(DEBUGGER_MAGIC) + 1 }).writeStringNT(DEBUGGER_MAGIC).toBuffer();
        this.CONTROLLER_CLIENT.write(buffer);
      });

      this.CONTROLLER_CLIENT.on('data', (buffer) => {
        if (this.unhandledData) {
          this.unhandledData = Buffer.concat([this.unhandledData, buffer]);
        } else {
          this.unhandledData = buffer;
        }

        this.parseUnhandledData(this.unhandledData);
      });

      this.CONTROLLER_CLIENT.on('end', () => {
        console.log('Requested an end to the TCP connection');
      });

      // Don't forget to catch error, for your own sake.
      this.CONTROLLER_CLIENT.on('error', function(err) {
        console.error(`Error: ${err}`);
      });
    })();

    console.timeEnd(debugSetupEnd);
  }

  public get isStopped(): boolean {
    return this.stopped;
  }

  public continue(): number {
    let commandSent = this.stopped ? this.makeRequest(new SmartBuffer({ size: 12 }), COMMANDS.CONTINUE) : -1;
    this.stopped = commandSent > -1;
    return commandSent;
  }

  public pause(): number {
    return !this.stopped ? this.makeRequest(new SmartBuffer({ size: 12 }), COMMANDS.STOP) : -1;
  }

  public exitChannel(): number {
    return this.makeRequest(new SmartBuffer({ size: 12 }), COMMANDS.EXIT_CHANNEL);
  }

  public stepIn(): number {
    return this.step(STEP_TYPE.STEP_TYPE_LINE);
  }

  public stepOver(): number {
    return this.step(STEP_TYPE.STEP_TYPE_OVER);
  }

  public stepOut(): number {
    return this.step(STEP_TYPE.STEP_TYPE_OUT);
  }

  private step(stepType: STEP_TYPE) {
    let buffer = new SmartBuffer({ size: 17 });
    buffer.writeUInt32LE(this.primaryThread); // thread_index
    buffer.writeUInt8(stepType); // step_type
    return this.stopped ? this.makeRequest(buffer, COMMANDS.STEP) : -1;
  }

  public threads(): number {
    return this.stopped ? this.makeRequest(new SmartBuffer({ size: 12 }), COMMANDS.THREADS) : -1;
  }

  public stackTrace(threadIndex: number = this.primaryThread): number {
    let buffer = new SmartBuffer({ size: 16 });
    buffer.writeUInt32LE(threadIndex); // thread_index
    return this.stopped && threadIndex > -1 ? this.makeRequest(buffer, COMMANDS.STACKTRACE) : -1;
  }

  public getVariables(variablePathEntries: Array<string> = [], getChildKeys: boolean = true, stackFrameIndex: number = this.stackFrameIndex, threadIndex: number = this.primaryThread): number {
    if (this.stopped && threadIndex > -1) {
      let buffer = new SmartBuffer({ size: 25 });
      buffer.writeUInt8(getChildKeys ? 1 : 0); // variable_request_flags
      buffer.writeUInt32LE(threadIndex); // thread_index
      buffer.writeUInt32LE(stackFrameIndex); // stack_frame_index
      buffer.writeUInt32LE(variablePathEntries.length); // variable_path_len
      variablePathEntries.forEach(variablePathEntry => {
        buffer.writeStringNT(variablePathEntry); // variable_path_entries - optional
      });
      return this.makeRequest(buffer, COMMANDS.VARIABLES, variablePathEntries);
    }
    return -1;
  }

  private makeRequest(buffer: SmartBuffer, command: COMMANDS, extraData?): number {
    let requestId = ++this.totalRequests;
    buffer.insertUInt32LE(command, 0); // command_code
    buffer.insertUInt32LE(requestId, 0); // request_id
    buffer.insertUInt32LE(buffer.writeOffset + 4, 0); // packet_length

    this.CONTROLLER_CLIENT.write(buffer.toBuffer());
    this.activeRequests[requestId] = {
      commandType: command,
      extraData: extraData
    };
    return requestId;
  }

  private parseUnhandledData(unhandledData: Buffer): boolean {
    if (this.handshakeComplete) {
      let debuggerRequestResponse = new DebuggerRequestResponse(unhandledData);
      if (debuggerRequestResponse.success) {
        let commandType = this.activeRequests[debuggerRequestResponse.requestId].commandType;
        if (commandType === COMMANDS.STOP || commandType === COMMANDS.CONTINUE || commandType === COMMANDS.STEP || commandType === COMMANDS.EXIT_CHANNEL) {
          this.removedProcessedBytes(debuggerRequestResponse, unhandledData);
          return true;
        }

        if (commandType === COMMANDS.VARIABLES) {
          let debuggerVariableRequestResponse = new DebuggerVariableRequestResponse(unhandledData);
          if (debuggerVariableRequestResponse.success) {
            this.removedProcessedBytes(debuggerVariableRequestResponse, unhandledData);
            return true;
          }
        }

        if (commandType === COMMANDS.STACKTRACE) {
          let debuggerStacktraceRequestResponse = new DebuggerStacktraceRequestResponse(unhandledData);
          if (debuggerStacktraceRequestResponse.success) {
            this.removedProcessedBytes(debuggerStacktraceRequestResponse, unhandledData);
            return true;
          }
        }

        if (commandType === COMMANDS.THREADS) {
          let debuggerThreadsRequestResponse = new DebuggerThreadsRequestResponse(unhandledData);
          if (debuggerThreadsRequestResponse.success) {
            this.removedProcessedBytes(debuggerThreadsRequestResponse, unhandledData);
            return true;
          }
        }
      }

      let debuggerUpdateThreads = new DebuggerUpdateThreads(unhandledData);
      if (debuggerUpdateThreads.success) {
        this.handleThreadsUpdate(debuggerUpdateThreads);
        this.removedProcessedBytes(debuggerUpdateThreads, unhandledData);
        return true;
      }

      let debuggerUpdateUndefined = new DebuggerUpdateUndefined(unhandledData);
      if (debuggerUpdateUndefined.success) {
        this.removedProcessedBytes(debuggerUpdateUndefined, unhandledData);
        return true;
      }

      let debuggerUpdateConnectIoPort = new DebuggerUpdateConnectIoPort(unhandledData);
      if (debuggerUpdateConnectIoPort.success) {
        this.connectToIoPort(debuggerUpdateConnectIoPort);
        this.removedProcessedBytes(debuggerUpdateConnectIoPort, unhandledData);
        return true;
      }

    } else {
      let debuggerHandshake = new DebuggerHandshake(unhandledData);
      if (debuggerHandshake.success) {
        return this.verifyHandshake(debuggerHandshake, unhandledData);
      }
    }

    return false;
  }

  private removedProcessedBytes(responseHandler, unhandledData: Buffer) {
    console.log(responseHandler);
    if (this.activeRequests[responseHandler.requestId]) {
      delete this.activeRequests[responseHandler.requestId];
    }

    this.unhandledData = unhandledData.slice(responseHandler.byteLength);
    this.parseUnhandledData(this.unhandledData);
  }

  private verifyHandshake(debuggerHandshake: DebuggerHandshake, unhandledData: Buffer): boolean {
    const magicIsValid = (DEBUGGER_MAGIC === debuggerHandshake.magic);
    if (magicIsValid) {
      console.log('Magic is valid.');
      this.protocolVersion = [debuggerHandshake.majorVersion, debuggerHandshake.minorVersion, debuggerHandshake.patchVersion, ''];
      console.log('Protocol Version:', this.protocolVersion.join('.'));

      this.handshakeComplete = true;
      this.removedProcessedBytes(debuggerHandshake, unhandledData);
      return true;
    } else {
      console.log('Closing connection due to bad debugger magic', debuggerHandshake.magic);
      this.CONTROLLER_CLIENT.end();
      return false;
    }
  }

  private connectToIoPort(connectIoPortResponse: DebuggerUpdateConnectIoPort) {
    // Create a new TCP client.
    const IO_CLIENT = new Net.Socket();
    // Send a connection request to the server.
    console.log('Connect to IO Port: port', connectIoPortResponse.data, 'host', this.host);
    IO_CLIENT.connect({ port: connectIoPortResponse.data, host: this.host }, () => {
      // If there is no error, the server has accepted the request
      console.log('TCP connection established with the IO Port.');

      let lastPartialLine = '';
      IO_CLIENT.on('data', (buffer) => {
        let responseText = buffer.toString();
        if (!responseText.endsWith('\n')) {
          // buffer was split, save the partial line
          lastPartialLine += responseText;
        } else {
          if (lastPartialLine) {
              // there was leftover lines, join the partial lines back together
              responseText = lastPartialLine + responseText;
              lastPartialLine = '';
          }

          console.log(responseText.trim());
        }
      });

      IO_CLIENT.on('end', () => {
        console.log('Requested an end to the IO connection');
      });

      // Don't forget to catch error, for your own sake.
      IO_CLIENT.on('error', (err) => {
        console.log(`Error: ${err}`);
      });
    });
  }

  private handleThreadsUpdate(update) {
    this.stopped = true;
    if (update.updateType === 'ALL_THREADS_STOPPED') {
      if (!this.firstRunContinueFired) {
        console.log('Sending first run continue command');
        this.continue();
        this.firstRunContinueFired = true;
      } else {
        this.primaryThread = update.data.primaryThreadIndex;
        this.stackFrameIndex = 0;

        this.threads();
        this.stackTrace();
        this.getVariables(['m']);
        this.stepIn();
      }
    } else {
    }
  }
}

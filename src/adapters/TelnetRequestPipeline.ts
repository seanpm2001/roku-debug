import type { Socket } from 'net';
import * as EventEmitter from 'eventemitter3';
import { util } from '../util';
import type { Logger } from '../logging';
import { createLogger } from '../logging';
import { Deferred } from 'brighterscript';

export class TelnetRequestPipeline {
    public constructor(
        public client: Socket
    ) {

    }

    private logger = createLogger(`[${TelnetRequestPipeline.name}]`);

    private commands: Command[] = [];

    public isAtDebuggerPrompt = false;

    public get isProcessing() {
        return this.activeCommand !== undefined;
    }

    private get hasCommands() {
        return this.commands.length > 0;
    }

    private activeCommand: Command = undefined;

    private emitter = new EventEmitter();

    public on(eventName: 'console-output', handler: (data: string) => void);
    public on(eventName: 'unhandled-console-output', handler: (data: string) => void);
    public on(eventName: string, handler: (data: any) => void) {
        this.emitter.on(eventName, handler);
        return () => {
            this.emitter.removeListener(eventName, handler);
        };
    }

    public emit(eventName: 'console-output', data: string);
    public emit(eventName: 'unhandled-console-output', data: string);
    public emit(eventName: string, data: any) {
        //run the event on next tick to avoid timing issues
        process.nextTick(() => {
            this.emitter.emit(eventName, data);
        });
    }

    /**
     * Start listening for future incoming data from the client
     */
    public connect() {
        this.client.addListener('data', (data) => {
            this.handleData(data.toString());
        });
    }

    /**
     * Any data that has not yet been fully processed. This could be a partial response
     * during a command execute, or a message split across multiple telnet terminals
     */
    public unhandledText = '';

    private handleData(data: string) {
        const logger = this.logger.createLogger(`[${TelnetRequestPipeline.prototype.handleData.name}]`);
        logger.debug('Raw telnet data', { data }, util.fence(data));

        //forward all raw console output to listeners
        this.emit('console-output', data);

        this.unhandledText += data;

        //ensure all debugger prompts appear completely on their own line
        this.unhandledText = util.ensureDebugPromptOnOwnLine(this.unhandledText);

        //discard all the "thread attached" messages as we find
        this.unhandledText = util.removeThreadAttachedText(this.unhandledText);

        //we are at a debugger prompt if the last text we received was "Brightscript Debugger>"
        this.isAtDebuggerPrompt = util.endsWithDebuggerPrompt(this.unhandledText);

        if (!this.isAtDebuggerPrompt && util.endsWithThreadAttachedText(this.unhandledText)) {
            //GIANT HACK!
            this.logger.log('Thread attached was possibly missing trailing debug prompt. Print an empty string which forces another debugger prompt.');
            this.client.write('print ""\r\n');
            //nothing more to do, let next call handle it.
            return;
        }

        if (this.isProcessing) {
            this.activeCommand.handleData(this);
        } else if (
            //ends with newline
            /\n\s*/.exec(this.unhandledText) ||
            //we're at a debugger prompt
            this.isAtDebuggerPrompt
        ) {
            this.emit('unhandled-console-output', this.unhandledText);
            this.unhandledText = '';
        } else {
            // buffer was split and was not the result of a prompt, save the partial line and wait for more output
        }
        //we can safely try to execute next command. if we're ready, it'll execute. if not, it'll wait.
        this.executeNextCommand();
    }

    /**
     * Send a command to the device immediately, without waiting for a response, and without worrying about
     * whether we are currently at a debugger prompt. (This is mostly used for "pause" commands")
     */
    public write(commandText: string) {
        this.client.write(`${commandText}\r\n`);
    }

    /**
     * Used to help with logging
     */
    private commandIdSequence = 0;

    /**
     * Schedule a command to be run. Resolves with the result once the command finishes.
     */
    public executeCommand(commandText: string, options: {
        waitForPrompt: boolean;
        /**
         * Should the command be inserted at the front? This means it will be the next command to execute
         */
        insertAtFront?: boolean;
    }) {
        const command = new Command(
            commandText,
            options?.waitForPrompt ?? true,
            this.logger,
            this,
            this.commandIdSequence++
        );
        const logger = command.logger;
        logger.debug(`execute`, { command: command, options });

        if (options?.insertAtFront) {
            this.commands.unshift(command);
        } else {
            this.commands.push(command);
        }

        //when this command completes, execute the next one
        command.promise.finally(() => {
            this.executeNextCommand();
        });

        //trigger an execute if not currently executing
        this.executeNextCommand();

        return command.promise;
    }

    /**
     * Executes the next command if no commands are running. If a command is running, exits immediately as that command will call this function again when it's finished.
     */
    public executeNextCommand() {
        const logger = this.logger.createLogger('[executeNextCommand]');
        logger.debug('begin');

        //if the current command is finished processing, clear the variable
        if (this.activeCommand?.isCompleted) {
            logger.debug('Clear activeCommand because it is completed');
            this.activeCommand = undefined;
        }

        if (this.commands.length === 0) {
            return logger.info('No commands to process');
        }

        if (this.isProcessing) {
            return logger.info('A command is already processing');
        }

        //we can only execute commands when we're at a debugger prompt. If we're not, then we'll wait until the next chunk of incoming data to try again to execute the command
        if (this.isAtDebuggerPrompt) {

            //get the next command from the queue
            this.activeCommand = this.commands.shift();
            logger.log('Process the next command', { remainingCommands: this.commands.length, activeCommand: this.activeCommand });

            //run the command. the on('data') event will handle launching the next command once this one has finished processing
            this.activeCommand.execute();
        }
    }

    public destroy() {
        this.client.removeAllListeners();
        this.client.destroy();
        this.client = undefined;
    }
}

class Command {
    public constructor(
        public commandText: string,
        /**
         * Should this command wait for the next prompt?
         */
        public waitForPrompt: boolean,
        logger: Logger,
        public pipeline: TelnetRequestPipeline,
        public id: number
    ) {
        this.logger = logger.createLogger(`[Command ${this.id}]`);
    }

    public logger: Logger;

    private deferred = new Deferred<string>();

    /**
     * Promise that completes when the command is finished
     */
    public get promise() {
        return this.deferred.promise;
    }

    public get isCompleted() {
        return this.deferred.isCompleted;
    }

    public execute() {
        try {
            let commandText = `${this.commandText}\r\n`;
            this.pipeline.emit('console-output', commandText);

            this.pipeline.client.write(commandText);

            if (this.waitForPrompt) {
                // The act of executing this command means we are no longer at the debug prompt
                this.pipeline.isAtDebuggerPrompt = false;
            }
        } catch (e) {
            this.logger.error('Error executing command', e);
            this.deferred.reject('Error executing command');
        }
    }

    /**
     * Remove garbage from the response
     */
    private removeJunk(text: string) {
        text = text
            //remove that pesky "may not be interruptible" warning
            .replace(/[ \t]*warning:\s*operation\s+may\s+not\s+be\s+interruptible.[ \t]*\r?\n?/i, '');
        return text;
    }


    public handleData(pipeline: TelnetRequestPipeline) {
        if (this.deferred.isCompleted) {
            console.log('stop here');
        }
        //get the first response
        const match = /Brightscript Debugger>\s*/is.exec(pipeline.unhandledText);
        if (match) {
            const response = this.removeJunk(
                pipeline.unhandledText.substring(0, match.index)
            );

            this.logger.debug('Found response before the first "Brightscript Debugger>" prompt', { response, allText: pipeline.unhandledText });
            //remove the response from the unhandled text
            pipeline.unhandledText = pipeline.unhandledText.substring(match.index + match[0].length);

            //emit the remaining unhandled text
            if (pipeline.unhandledText?.length > 0) {
                pipeline.emit('unhandled-console-output', pipeline.unhandledText);
            }
            //clear the unhandled text
            pipeline.unhandledText = '';

            this.logger.debug(`execute result`, { commandText: this.commandText, response });
            if (!this.deferred.isCompleted) {
                this.logger.debug('resolving promise', { response });
                this.deferred.resolve(response);
            } else {
                this.logger.error('Command already completed', { response, commandText: this.commandText, stacktrace: new Error().stack });
            }
        } else {
            // no prompt found, wait for more data from the device
        }
    }
}
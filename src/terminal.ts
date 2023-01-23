import * as vscode from "vscode";
import * as os from "os";
import { Duplex, PassThrough, Readable } from "stream";
import { EventEmitter } from "events";
import * as fs from "fs";
import { inspect, promisify } from "util";
import { exec } from "child_process";

type SubProcess = { stdout: Readable; stderr: Readable };
type TaskProps = Omit<TaskComposerProps, "command" | "cwd">;

type ExitInfo = {
  code: number;
  signal: number;
};
type OnDidFinishArgs = { cancelledByUser?: boolean; exitInfo?: ExitInfo };

const REMOTE_LAUNCHER_TERMINAL_TASK_SOURCE = "Remote Launcher";

type CommandArgs = {
  commandLine: string;
  onDidWriteOutput?: (output: string) => void;
  path?: string;
  environment?: Map<string, string>;
};

type Command = {
  file: string;
  args: Array<string>;
};

type RunCommandResult = {
  // A promise returning the exit info if the command successfully finishes.
  commandPromise: Promise<ExitInfo | undefined>;
  // The pty to associate to a terminal.
  pseudoTerminal: vscode.Pseudoterminal;
  // The emitter associated to the pty's onDidWrite function.
  writeEmitter: vscode.EventEmitter<string>;
  // Event that fires when the pty is ready to accept writes.
  ready: vscode.Event<void>;
};

function sleep(milliSeconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliSeconds);
  });
}

let currentTerminal:
  | { terminal: vscode.Terminal; subscriptions: vscode.Disposable }
  | undefined;

export async function createTerminal(title: string): Promise<VSCodeTerminal> {
  const result = new VSCodeTerminal(REMOTE_LAUNCHER_TERMINAL_TASK_SOURCE, {
    title,
    presentationOptions: {
      reveal: undefined,
    },
  });

  // The task runner system that lets us show progress in the terminal doesn't get a reference to the actual `vscode.terminal` it runs in.
  // Look for the next matching terminal that gets created, and use that as the terminal.
  const listener = vscode.window.onDidOpenTerminal((terminal) => {
    if (!terminal.name.startsWith(REMOTE_LAUNCHER_TERMINAL_TASK_SOURCE)) {
      return;
    }

    currentTerminal?.subscriptions.dispose?.();

    const subscriptions = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        currentTerminal?.subscriptions.dispose?.();
        currentTerminal = undefined;
      }
    });
    currentTerminal = { terminal, subscriptions };

    listener.dispose();
  });

  return result;
}

export class VSCodeTerminal extends EventEmitter {
  private _stream = new PassThrough();

  private state: "created" | "started" | "stopped" | "closed";
  private task: vscode.Task;
  private taskExecution?: vscode.TaskExecution;

  // HACK, using same pipe for each, fine for temp repro
  private pipeName: string = `${os.tmpdir()}/__terminaltemp__`; //   temp.path();
  private fsStream?: fs.WriteStream;

  private minTimeToRunTask: Promise<void> | null = null;

  get stream(): Duplex {
    return this._stream;
  }

  pipeProcess({ stdout, stderr }: SubProcess): void {
    stdout.pipe(this.stream, { end: false });
    stderr.pipe(this.stream, { end: false });
  }

  constructor(source: string, props: TaskProps) {
    super();
    this.state = "created";
    this.task = composeTask(source, {
      ...props,
      cwd: "/",
      // command: `cat ${this.pipeName}`,
      command: `echo relative/path/to/a/file.txt && echo && ls ${os.homedir()}`,
      onDidFinish: async (cancelledByUser, exitInfo) => {
        if (this.state === "started") {
          await this.stop({ cancelledByUser, exitInfo });
          console.log(
            `Terminal task terminated: ${inspect({
              cancelledByUser,
              exitInfo,
            })}`
          );
        }
        return props?.onDidFinish?.(cancelledByUser, exitInfo);
      },
    });
  }

  /**
   * Start the modular terminal, making it available in the VS Code TERMINAL dropdown.
   */
  async start() {
    switch (this.state) {
      case "created":
        this.state = "started";
        try {
          await fs.promises.unlink(this.pipeName);
        } catch {}
        await promisify(exec)(`mkfifo ${this.pipeName}`);
        this.fsStream = fs.createWriteStream(this.pipeName, {
          autoClose: false,
        });
        this.stream.pipe(this.fsStream);
        this.taskExecution = await vscode.tasks.executeTask(this.task);
        this.minTimeToRunTask = sleep(2000); // 2 seconds
        break;
      default:
        throw new Error(
          `Cannot start a ModularTerminal in '${this.state}' state.`
        );
    }
  }

  /**
   * Stop the modular terminal and clean up resources.
   */
  async stop({ cancelledByUser, exitInfo }: OnDidFinishArgs = {}) {
    switch (this.state) {
      case "created":
      // passthrough
      case "started":
        // There is a potential race condition where this 'stop' method is called
        // before the task actually starts running and cat'ing the fifo.
        // Here we wait at least some minimum time before cleaning up resources,
        // which prevents the task from erroring with, for example,
        // "cat: /tmp/2022419-3506246-1s3ytxr.zrto: No such file or directory"
        await this.minTimeToRunTask;

        this.state = "stopped";

        if (exitInfo) {
          // When this happens we assume the underlying 'cat' process
          // was killed somehow (probably by the user). We figure out
          // what signal killed it, so that signal can potentially be
          // propagated directly to any subprocess that was being piped
          // into this terminal.
          // If a non-0 signal is not explicitly given, assume
          // the convention that exitCode = 128 + signalNr.
          // If that doesn't work, default to SIGINT.
          const { code } = exitInfo;
          const signal =
            exitInfo.signal || (code > 128 ? code - 128 : "SIGINT");
          this.emit("stop", { cancelledByUser, code, signal });
        } else {
          this.emit("stop", { cancelledByUser });
        }

        this.fsStream?.close();
        this.fsStream?.destroy();
        this.fsStream = undefined;

        fs.promises.unlink(this.pipeName); // no need to await
        break;
      case "stopped":
        // Already stopped. Do nothing.
        break;
      default:
        throw new Error(
          `Cannot stop a ModularTerminal in '${this.state}' state.`
        );
    }
  }

  // Close the modular terminal. This includes a call to `stop()` if necessary.
  async close() {
    switch (this.state) {
      case "created":
        break;
      case "started":
        await this.stop();
      // falls through
      case "stopped":
        this.taskExecution?.terminate();
        this.taskExecution = undefined;
        break;
    }
    this.state = "closed";
  }
}

function composeTask(taskType: string, props: TaskComposerProps): vscode.Task {
  const {
    cwd,
    env,
    title,
    command,
    onDidWriteOutput,
    onWillStart,
    onDidFinish,
  } = props;

  const definition: vscode.TaskDefinition = {
    type: taskType,
    name: title,
  };
  // Do nothing if the logging method is undefined or null
  const doLogging = !props.executionLogging
    ? (commandPromise: () => Promise<ExitInfo | undefined>) => commandPromise()
    : props.executionLogging;

  const callback = async () => {
    if (onWillStart) {
      console.log("Invoking onWillStart()");
      await onWillStart();
    }

    console.log("Starting task:", title);
    console.log("Path:", cwd);
    console.log("Command:", command);
    const { commandPromise, pseudoTerminal, writeEmitter, ready } =
      await runCommand({
        path: cwd,
        commandLine: command,
        environment: env,
        onDidWriteOutput,
      });
    const workerCallback = async () => {
      writeEmitter.fire(`Executing in directory: ${cwd}\r\n`);
      writeEmitter.fire(`${command}\r\n`);
      writeEmitter.fire(`\r\n`);

      let exitInfo: ExitInfo | undefined;
      try {
        exitInfo = await doLogging(() => commandPromise);
      } catch (error) {
        handleTaskCrash(title, error as Error, writeEmitter);
      }

      const cancelledByUser = exitInfo === null;
      console.log(`Task '${title}' finished with:`, exitInfo);

      if (onDidFinish) {
        console.log("Invoking onDidFinish()");
        await onDidFinish(cancelledByUser, exitInfo);
      }

      pseudoTerminal.close();
    };

    ready(async () => workerCallback());

    return pseudoTerminal;
  };

  const customExecution = new vscode.CustomExecution(callback);
  const task = new vscode.Task(
    definition,
    vscode.TaskScope.Workspace,
    title,
    taskType,
    customExecution
  );
  if (props.presentationOptions) {
    task.presentationOptions = props.presentationOptions;
  }
  return task;
}

function handleTaskCrash(
  title: string,
  error: Error,
  writeEmitter: vscode.EventEmitter<string>
): void {
  const crashMessage = `Task '${title}' has crashed.`;

  vscode.window.showErrorMessage(
    crashMessage +
      " The crash details are displayed in the terminal." +
      " If this is unexpected, please file a bug from the editor."
  );

  writeEmitter.fire(
    [
      crashMessage,
      "",
      // Node produces traces with \n. We need to use \r\n for the renderer.
      (error.stack || error.toString()).replace(/(?<=[^\r])\n/g, "\r\n"),
      "",
    ].join("\r\n")
  );

  console.log(crashMessage);
  console.log(error.stack);
}

async function runCommand(args: CommandArgs): Promise<RunCommandResult> {
  const { commandLine, path, onDidWriteOutput, environment } = args;

  if (commandLine.trim().length < 1) {
    throw new Error(`Passed 'commandLine' must not be empty.`);
  }

  const deferred = new Deferred<ExitInfo | undefined>();

  const closeEmitter = new vscode.EventEmitter<void>();
  const openEmitter = new vscode.EventEmitter<undefined>();
  const writeEmitter = new vscode.EventEmitter<string>();
  const readyEmitter = new vscode.EventEmitter<void>();

  // Clean up the emitters when the pty is closed.
  closeEmitter.event(() => {
    openEmitter.dispose();
    writeEmitter.dispose();
    readyEmitter.dispose();
  });

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => openEmitter.fire(undefined),
    close: () => {
      // Signal to VSCode APIs that the process is done
      closeEmitter.fire();
      // dispose of the emitter afterwards
      closeEmitter.dispose();
    },
  };

  const ptyClient = new CommandRendererPtyClient(
    writeEmitter,
    (info: ExitInfo) => deferred.resolve(info),
    onDidWriteOutput
  );

  const command: Command = await getExecutionShellCommand(
    ptyClient,
    commandLine
  );

  const ptyInfo: PtyInfo = {
    command,
    cwd: path,
    environment: getDefaultEnvironment(),
    terminalType: "xterm-256color",
    vscodeAppRoot: vscode.env.appRoot,
  };

  // The connection cannot occur until the pty has been hooked up to an associated terminal.
  // Otherwise, a race occurs where the spawned terminal command starts showing output before
  // the actual rendering terminal is ready to accept output.
  openEmitter.event(() => {
    readyEmitter.fire();
    const ptyInstance = spawnAndConnectTerminal(pty, ptyInfo, ptyClient);

    // Clean up the pty when closed by a user action.
    closeEmitter.event(() => {
      ptyInstance.then((instance) => instance.dispose());
      deferred.resolve(undefined);
    });
  });

  return {
    commandPromise: deferred.promise,
    pseudoTerminal: pty,
    writeEmitter,
    ready: readyEmitter.event,
  };
}

interface Pty {
  resize: (columns: number, rows: number) => void;
  writeInput: (data: string) => void;
  dispose: () => void;
}

type PtyInfo = {
  terminalType: string;
  environment?: Map<string, string>;
  cwd?: string;
  command?: Command;
  vscodeAppRoot?: string;
};

async function spawnAndConnectTerminal(
  pty: vscode.Pseudoterminal,
  ptyInfo: PtyInfo,
  ptyClient: PtyClient
): Promise<Pty> {
  const ptyInstance = await spawn(ptyInfo, ptyClient);

  // Listen to input from the user to forward to the terminal.
  pty.handleInput = (data: string) => ptyInstance.writeInput(data);
  // Listen to when the window dimensions change and update the terminal accordingly.
  // We don't initialize the terminal's size, because the initial size is undefined until
  // the underlying terminal for the terminal renderer gets displayed in the window.
  pty.setDimensions = (newMaxDimensions: vscode.TerminalDimensions) => {
    ptyInstance.resize(newMaxDimensions.columns, newMaxDimensions.rows);
  };

  return ptyInstance;
}

function getCommand(info: PtyInfo, client: PtyClient): Command {
  // Client-specified command is highest precedence.
  if (info.command) {
    return info.command;
  }
  throw new Error("need info.command");
}

async function spawn(info: PtyInfo, client: PtyClient): Promise<Pty> {
  return new PtyImplementation(
    info,
    client,
    await getCommand(info, client),
    {}
  );
}

interface TaskComposerProps {
  readonly title: string;
  readonly cwd: string;
  readonly env?: Map<string, string>;
  readonly command: string;
  readonly description?: string;
  readonly presentationOptions?: vscode.TaskPresentationOptions;
  readonly onDidWriteOutput?: (output: string) => void;
  onWillStart?: () => Promise<void>;
  onDidFinish?: (
    cancelledByUser: boolean,
    exitInfo: ExitInfo | undefined
  ) => Promise<void>;
  // Log upon task execution
  readonly executionLogging?: <T>(operation: () => T) => T;
}

function getDefaultEnvironment(): Map<string, string> {
  const env: Map<string, string> = new Map([
    // The `code` shell script uses this env. var. to communicate files to edit, etc. to vscode.
    ["TERM_PROGRAM", "vscode"],
  ]);
  return env;
}

async function getExecutionShellCommand(
  client: PtyClient,
  commandLine: string
): Promise<Command> {
  // TODO: may need to fix this...

  let command = {
    file: "/bin/bash",
    args: ["-l"],
  };

  if (process.platform === "win32") {
    command = {
      file: "powershell.exe",
      args: [],
    };
  }

  // Force args for an execution shell
  if (command.file.includes("powershell.exe")) {
    command.args = ["-command", commandLine];
  } else {
    command.args = ["-i", "-c", commandLine];
  }

  return command;
}

interface PtyClient {
  onOutput: (data: string) => void;
  onExit: (code: number, signal: number) => void;
  dispose: () => void;
}

class CommandRendererPtyClient implements PtyClient {
  constructor(
    private writeEmitter: vscode.EventEmitter<string>,
    private onExitCallback: (info: ExitInfo) => void,
    private onOutputCallback?: (data: string) => void
  ) {}

  onOutput(data: string): void {
    if (data && data.length > 0) {
      this.writeEmitter.fire(data);

      if (this.onOutputCallback) {
        this.onOutputCallback(data);
      }
    }
  }

  onExit(code: number, signal: number): void {
    this.onExitCallback({ code, signal });
  }

  dispose(): void {
    console.log("Disposed pty client for a terminal command.");
  }
}

class PtyImplementation implements Pty {
  _subscriptions: vscode.Disposable;
  _pty: any;
  _client: PtyClient;
  _initialization: {
    command: string;
    cwd: string;
  };
  _bytesIn: number;
  _bytesOut: number;

  constructor(info: PtyInfo, client: PtyClient, command: Command, env: any) {
    this._bytesIn = 0;
    this._bytesOut = 0;
    this._initialization = {
      command: [command.file, ...command.args].join(" "),
      cwd: info.cwd ?? "",
    };

    const subscriptions = (this._subscriptions = new vscode.Disposable(
      () => {}
    ));
    const ptyProcess = (this._pty = getPtyFactory(info).spawn(
      command.file,
      command.args,
      {
        name: info.terminalType,
        cwd: info.cwd,
        env,
      }
    ));
    // TODO(zube): comment out all of the subscriptions.  i think these are just for cleanup.
    //   subscriptions.add(() => pty.destroy());
    //   subscriptions.add(client);
    this._client = client;

    const onOutput = this._onOutput.bind(this);
    ptyProcess.on("data", onOutput);
    //   subscriptions.add(() => pty.removeListener('data', onOutput));

    const onExit = this._onExit.bind(this);
    // ptyProcess.on("exit", onExit);
    //   subscriptions.push(() => pty.removeListener('exit', onExit));
  }

  _onOutput(data: string): void {
    this._bytesOut += data.length;
    this._client.onOutput(data);
  }

  _onExit(code: number, signal: number): void {
    this._client.onExit(code, signal);
  }

  dispose(): void {
    this._subscriptions.dispose();
  }

  _isWritable(): boolean {
    return this._pty._writable;
  }

  resize(columns: number, rows: number): void {
    if (this._isWritable()) {
      this._pty.resize(columns, rows);
    }
  }

  writeInput(data: string): void {
    if (this._isWritable()) {
      this._bytesIn += data.length;
      this._pty.write(data);
    }
  }
}

function getPtyFactory(ptyInfo: PtyInfo) {
  try {
    return require(`${ptyInfo.vscodeAppRoot}/node_modules.asar/node-pty`);
  } catch {
    return require(`${ptyInfo.vscodeAppRoot}/node_modules/node-pty`);
  }
}

class Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void = () => {
    throw new Error("resolve isn't set");
  };
  reject: (error: Error) => void = () => {
    throw new Error("reject isn't set");
  };

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

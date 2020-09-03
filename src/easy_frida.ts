
import fs = require('fs');
import path = require('path');
import process = require('process');
import { format } from 'util';

import AsyncLock = require('async-lock');
import frida = require('frida');
import compiler = require('frida-compile');

import { FridaRepl } from './frida_repl';

const lock = new AsyncLock();

interface FridaProcess {
    session: frida.Session
    script: frida.Script
    onDetach: () => void
}

export default class EasyFrida {
    compileOptions = {
        bytecode: false,
        babelify: false,
        esmify: false,
        loose: false,
        sourcemap: true,
        compress: true,
        useAbsolutePaths: true
    }
    baseDir = process.cwd()
    agentProjectDir = path.join(this.baseDir, "agent/")
    outFile = path.join(this.baseDir, "agent.js")
    logFile?: string
    scriptFile?: string
    device?: frida.Device
    private curProc: FridaProcess = null
    private procList: FridaProcess[] = []
    private interacting = false
    private fridaRepl: FridaRepl
    private scopeDepth = 0
    private prompt: string
    private remoteEvalCallback: (result: any) => void
    private enableChildGating = false
    constructor(public target: number | string, public location: 'usb' | 'local' | 'remote', public targetos: 'win' | 'linux' | 'android' | 'ios', public remoteAddr?: string) {
    }

    run(target = this.target, enableChildGating = false): Promise<boolean> {
        if(typeof(target) === 'number') {
            return this.attach(target, enableChildGating);
        }
        return new Promise(resolve => {
            this.getDevice()
            .then(device => {
                this.log(`[+] Spawning ${target}...`);

                device.spawn(target)
                .then(pid => {
                    this.attach(pid, enableChildGating).then(resolve);
                })
                .catch(e => {
                    console.log(`[!] Spawn failed: ${e.message}`);
                    resolve(false);
                })
            })
        });
    }

    attach(target = this.target, enableChildGating = false): Promise<boolean> {
        this.enableChildGating = enableChildGating;
        return new Promise(resolve => {
            this.getDevice().then(device => {
                device.attach(target).then(sess => {
                    this.attachToSession(sess);
                    resolve(true);
                })
                .catch(e => {
                    if(e.message.indexOf('Ambiguous name') >= 0) {
                        console.log(e.message);
                        const pid = e.message.match(/pid\: (\d+)/)[1];
                        console.log(`[!] Attaching to ${pid} ...`);
                        this.device.attach(parseInt(pid)).then(sess => {
                            this.attachToSession(sess);
                            resolve(true);
                        });
                    }
                    else throw e;
                })
            });
        });
    }

    attachOrRun(target = this.target, enableChildGating = false): Promise<boolean> {
        return new Promise(resolve => {
            this.attach(target, enableChildGating).then(resolve)
            .catch(async e => {
                if(e.message === "Process not found")
                    this.run(target, enableChildGating).then(resolve);
                else {
                    console.log("[!] Attach Error: ", e.message);
                    resolve(false);
                }
            });
        });
    }

    inject(file = this.scriptFile, target = this.target, enableChildGating = false) {
        return this.attachOrRun(target, enableChildGating).then(attached => {
            if(attached) {
                this.compile(file)
                .then(() => this.load())
                .then(() => this.resume())
            }
        }).catch(console.log)
    }

    resume(pid?: number) {
        if(pid === undefined) 
            this.device.resume(this.curProc.session.pid).catch(()=>{});
        else
            this.device.resume(pid).catch(()=>{});
    }

    getDevice(): Promise<frida.Device> {
        return new Promise(resolve => {
            if(this.device !== undefined) resolve(this.device);

            const getDeviceCallback = (device: frida.Device) => {
                this.device = device;
                device.childAdded.connect(this.onChild);
                device.processCrashed.connect(this.onCrashed);
                resolve(device);
            }
            switch(this.location) {
                case 'local':
                    frida.getLocalDevice().then(getDeviceCallback);
                    break;
                case 'remote':
                    frida.getDeviceManager().addRemoteDevice(this.remoteAddr).then(getDeviceCallback);
                    break;
                case 'usb':
                    frida.getUsbDevice({timeout: null}).then(getDeviceCallback);
                    break;
            }
        });
    }

    private attachToSession = (session: frida.Session) => {
        if(this.enableChildGating) session.enableChildGating();
        console.log(`[+] Attached to ${session.pid}.`);
        
        const tmpProc: FridaProcess = Object.create(null);
        tmpProc.session = session;
        
        tmpProc.onDetach = () => {
            const idx = this.procList.indexOf(tmpProc);
            if(idx < 0) return;
            this.log(`[!] Detached from pid ${tmpProc.session.pid}.`);
            this.procList.splice(idx, 1);

            if(this.curProc === tmpProc && this.procList.length > 0) {
                this.curProc = this.procList[0];
                this.log(`[+] Switch to pid ${this.curProc.session.pid}.`);
            } else {
                this.curProc = Object.create(null);
                if(this.interacting) {
                    this.fridaRepl.useLocalEval = true;
                    this.updatePrompt();
                }
                this.log(`[!] all detached.`);
            }
        }

        session.detached.connect(tmpProc.onDetach);
        this.procList.push(tmpProc);
        this.curProc = tmpProc;
            if(this.interacting) {
            this.fridaRepl.useLocalEval = false;
            this.updatePrompt();
        }
    }

    async reload() {
        if(this.procList.length > 0) {
            lock.acquire("reload", async () => {
                const curpid = this.curProc.session.pid;
                for(let i in this.procList) {
                    this.curProc = this.procList[i];
                    await this.load();
                }
                
                for(let i in this.procList) {
                    if(this.procList[i].session.pid == curpid) {
                        this.curProc = this.procList[i];
                        break;
                    }
                }
                
                if(this.procList.length !== 0) {
                    this.fridaRepl.useLocalEval = false;
                    this.updatePrompt();
                }
            }, null, null);
        }
    }

    compile(file = this.scriptFile) {
        return new Promise(resolve => {
            process.chdir(this.agentProjectDir);
            lock.acquire('compile', async () => {
                await compiler.build(path.join(this.baseDir, file), this.outFile, this.compileOptions)
                .then(resolve)
            }, null, null);
            process.chdir(this.baseDir);
        })
    }

    async load(file = this.outFile) {
        const curProc = this.curProc;
        const source = fs.readFileSync(file, "utf-8");
        const script = await curProc.session.createScript(source, {runtime: frida.ScriptRuntime.V8});
        script.logHandler = (level, text) => {
            this.log(text);
        }
        script.message.connect(this.onMessage.bind(this));
        // script.destroyed.connect();
        
        let oldscript = this.curProc.script;
        if(oldscript) {
            // oldscript.destroyed.disconnect();
            await oldscript.unload();
        }
        
        this.curProc.script = script;
        await script.load();
    }

    async watch(file = this.scriptFile, target = this.target, enableChildGating = false) {
        await this.attachOrRun(target, enableChildGating);
        process.chdir(this.agentProjectDir);
        compiler.watch(path.join(this.baseDir, file), this.outFile, this.compileOptions)
        .on('compile', details => {
            const duration = details.duration;
            this.log(`[+] Compile fin (${duration} ms)`);
            if(this.interacting && this.scopeDepth !== 0) {
                this.log(`[!] can't reload when script is busy, please quit scope and retry.`);
            } else {
                // wait for flush
                setTimeout(this.reload.bind(this), 50);
            }
        })
        .on('error', error => {
            const message = error.toString();
            this.log(message);
            this.log("[!] Compilation failed.");
        });
        process.chdir(this.baseDir);
    }

    async interact(finallyKill = false) {
        process.on('SIGINT', () => {});
        const fridaRepl = new FridaRepl(this.localEval, this.remoteEval, this.log);
        this.interacting = true;
        fridaRepl.start();
        this.fridaRepl = fridaRepl;
        this.updatePrompt();
        fridaRepl.repl.setupHistory(path.join(this.baseDir, ".easy_frida_history"), (e, r) => {});
        
        fridaRepl.repl.on('exit', onExit.bind(this));
        function onExit() {
            try {
                if(finallyKill) {
                    this.kill().then( () => { process.exit(); });
                }
                else {
                    this.detach().then( () => { process.exit(); });
                }
            }
            catch(e) {
                console.log(e);
                process.exit();
            }
        }
    }

    private localEval = (code: string) => {
        return eval(code);
    }

    private remoteEval = (code: string) => {
        if(this.scopeDepth === 0) {
            return this.curProc.script.exports.exec(code);
        }
        return new Promise(resolve => {
            this.curProc.script.post({"type":"scope", "code":code});
            this.remoteEvalCallback = resolve;
        });
    }

    private async onChild(child: frida.Child) {
        await this.attach(child.pid);
        await this.load().catch( e => {console.log(e);});
        this.resume(child.pid);
    }

    private onCrashed(crash: frida.Crash) {
        console.log("");
        console.log(crash.summary);
        console.log(crash.report);
        console.log(crash.parameters);
    }

    private log = (message: any) => {
        if(this.logFile !== undefined) {
                fs.writeFileSync(this.logFile, format(message) + "\n", { flag: 'a' });
        }
        if(this.interacting) {
            process.stdout.write("\r" + ' '.repeat(this.prompt.length + this.fridaRepl.repl.line.length) + "\r");
        }
        console.log(message);
        if(this.interacting) {
            process.stdout.write(this.prompt);
            process.stdout.write(this.fridaRepl.repl.line);
        }
    }

    async detach() {
        for(let i in this.procList) {
            this.procList[i].session.detached.disconnect(this.procList[i].onDetach);
            await this.procList[i].session.detach().catch(()=>{});
        }
        
        this.procList = [];
        this.curProc = null;
    }

    async kill() {
        if(this.procList.length) {
            console.log("\nkilling", this.target); // repl
            for(let i in this.procList) {
                await this.device.kill(this.procList[i].session.pid).catch(()=>{});
            }
            this.procList = [];
            this.curProc = null;
        }
    }
    
    private onMessage(message: frida.Message, data: Buffer | null) {
        switch (message.type) {
            case frida.MessageType.Send:
                const payload = message.payload;
                switch(payload.type) {
                    case "scope":
                        if(payload.act == "enter") {
                            this.scopeDepth += 1;
                            this.updatePrompt();
                        }
                        else if (payload.act == "quit") {
                            this.scopeDepth -= 1;
                            this.updatePrompt();
                        }
                        else if (payload.act == "result") {
                            this.remoteEvalCallback(payload.result);
                        }
                        break;
                    case "rpc":
                        // TODO
                    default:
                        this.log(payload);
                        break;
                }
                break;
            case frida.MessageType.Error:
                this.log(message.stack);
                break;
        }
    }
    
    private updatePrompt() {
        if(this.fridaRepl === undefined) return;
        if(this.fridaRepl.useLocalEval) {
            this.prompt = "[local->nodejs] > ";
        }
        else if(this.scopeDepth === 0) {
            this.prompt = `[${this.device.name}->${this.target}] > `;
        }
        else {
            this.prompt = `[${this.device.name}->${this.target}>scope(${this.scopeDepth})] > `;
        }
        this.fridaRepl.repl.setPrompt(this.prompt);
        this.fridaRepl.repl.displayPrompt();
    }
}

export function showBacktrace(context?: CpuContext) {
    let bt = Thread.backtrace(context, Backtracer.ACCURATE).map(symbolName).join("\n\t");
    console.log('\t' + bt);
}
/**
 * similar to hexdump,  
 * for lazy people who don't want to write "console.log(hexdump(...))" when debuging.
 */
export function d(address: number | NativePointer, size?: number) {
    let p: NativePointer;
    if(address instanceof NativePointer) {
        p = address;
    } else {
        p = ptr(address);
    }
    if(size) {
        console.log(hexdump(p, {length:size}));
    } else {
        console.log(hexdump(p));
    }
}
/**
 * warpper for NativeFunction, add 'string' type.
 * slower, just for convenience.
 */
export function makefunction(
        libnameOrFuncaddr: string | NativePointerValue | null,
        funcName: string,
        retType: NativeType,
        argTypes: NativeType[],
        abiOrOptions?: NativeABI | NativeFunctionOptions) {
    let funcAddress: NativePointerValue;
    const realArgTypes: NativeType[] = [];
    let nativeFunction: NativeFunction;

    if (libnameOrFuncaddr === null || typeof libnameOrFuncaddr === 'string') {
        funcAddress = Module.getExportByName(libnameOrFuncaddr as any, funcName);
    } else funcAddress = libnameOrFuncaddr;
    
    argTypes.forEach(type => {
        if(type === 'string') realArgTypes.push('pointer');
        else realArgTypes.push(type);
    });
    if(retType === 'string') {
        if(abiOrOptions)
            nativeFunction = new NativeFunction(funcAddress, 'pointer', realArgTypes, abiOrOptions);
        else
            nativeFunction = new NativeFunction(funcAddress, 'pointer', realArgTypes);
    }
    else {
        if(abiOrOptions)
            nativeFunction = new NativeFunction(funcAddress, retType, realArgTypes, abiOrOptions);
        else
            nativeFunction = new NativeFunction(funcAddress, retType, realArgTypes);
    }

    return function(...args: (NativeArgumentValue | string)[]) {
        let nativeArgs: NativeArgumentValue[] = [];
        for(const arg of args) {
            if(typeof arg === 'string') {
                nativeArgs.push(Memory.allocUtf8String(arg));
            }
            else nativeArgs.push(arg);
        }
        let retVal = nativeFunction(...nativeArgs);
        if(retType === 'string') {
            return (retVal as NativePointer).readCString();
        }
        return retVal;
    }
}

let customNames: {
    address: number,
    size: number,
    name: string
}[] = [];
/**
 * set custom debug symbol name to range.
 * show as name or name+offset.
 */
export function setName(address: number | NativePointer, size: number, name: string) {    
    if(address instanceof NativePointer) address = parseInt(address.toString());
    customNames.push({address, size, name});
}

export function symbolName(address: number | NativePointer) {
    let name: string;
    if(typeof address === 'number') address = ptr(address);
    const addressvalue = parseInt(address.toString());
    for(const customName of customNames) {
        const s_addr = customName.address;
        const size = customName.size;
        if(addressvalue >= s_addr && addressvalue < s_addr+size) {
            const offset = addressvalue-s_addr;
            name = customName.name;
            if(offset) name += "+"+ptr(offset);
            return name;
        }
    }

    const debugSymbol = DebugSymbol.fromAddress(address);
    const range = Process.findRangeByAddress(address);
    if(Process.platform !== 'windows' && debugSymbol && range) {
        name = debugSymbol.toString()+' ('+range.base+'+'+address.sub(range.base)+')';
    } else if(range) {
        name = '('+range.base+'+'+address.sub(range.base)+')';
        if(range.file)
            name = range.file.path + name;
    } else if(debugSymbol) {
        name = address + ' ' + debugSymbol.moduleName;
        if(debugSymbol.name !== null) {
            let symbolBase = DebugSymbol.fromName(debugSymbol.name);
            let offset = address.sub(symbolBase.address);
            name += '!' + debugSymbol.name + '+' + offset;
        }
        if(debugSymbol.fileName !== null) {
            const basepos = debugSymbol.fileName.lastIndexOf('/');
            name += '(' + debugSymbol.fileName.slice(basepos + 1) + ':' + debugSymbol.lineNumber + ')';
        }
    }
    else {
        name = address.toString();
    }
    return name;
}
/**
 * show addrinfo from DebugSymbol.fromAddress, findModuleByAddress and findRangeByAddress.
 */
export function showAddrInfo(address: number | NativePointer) {
    if(typeof address === 'number') address = ptr(address);
    const debugSymbol = DebugSymbol.fromAddress(address);
    const module = Process.findModuleByAddress(address);
    const range = Process.findRangeByAddress(address);
    console.log("AddrInfo of", address, ":");
    console.log("\t" + JSON.stringify(debugSymbol));
    console.log("\t" + JSON.stringify(module));
    console.log("\t" + JSON.stringify(range));
};
/**
 * dump memory to file.
 */
export function dumpMem(address: number | NativePointer, size:number, outname: string) {
    if(typeof address === 'number') address = ptr(address);
    const out = new File(outname, "wb");
    const protection = Process.findRangeByAddress(address).protection;

    if(protection && protection[0] != 'r') {
        Memory.protect(address, size, 'r'+protection.slice(1));
    }
    const data = address.readByteArray(size) || "";
    out.write(data);
    out.close();
    if(protection && protection[0] != 'r') {
        Memory.protect(address, size, protection);
    }
};

function readNativeArg (handle: NativePointer, name: string) {
    let type = name[0];
    switch(type) {
        case 'p': //Pointer
            return handle;
        case 'i': //Int
            return handle.toInt32();
        case 's': //String
            return handle.readCString();
        case 'd': //Data
            if(!handle.isNull()) {
                if(parseInt(name.slice(1)))
                    return '\n' + hexdump(handle, {length:parseInt(name.slice(1))}) + '\n';
                else
                    return '\n' + hexdump(handle) + '\n';
            }else {
                return 'null';
            }
        case 'v': //Pointer => Value
            return handle + '=>' + handle.readPointer();
        case 'w': //Pointer => Value(Pointer) => Value
            return handle + '=>' + handle.readPointer()
                          + '=>' + handle.readPointer().readPointer();
        case 'r': //Register
            // TODO
        default:
            return handle+'(miss type)';
    }
}

function getArgName(name: string) {
    return name.substr(name.indexOf(".")+1);
}

export function traceCalled(libnameOrFuncaddr: string | NativePointerValue | null, funcName: string) {
    let funcAddr: NativePointerValue;
    if(!libnameOrFuncaddr || typeof(libnameOrFuncaddr) == 'string') {
        funcAddr = Module.getExportByName(libnameOrFuncaddr as any, funcName);
    } else {
        funcAddr = libnameOrFuncaddr;
    }
    let _hooks: InvocationListenerCallbacks = {
        onEnter: function (args) {
            let tid = Process.getCurrentThreadId();
            console.log(`\n[${tid}]\t${funcName} called at ${symbolName(this.returnAddress)}`);
        },
        onLeave: function (retVal) {
            let tid = Process.getCurrentThreadId();
            console.log(`\n[${tid}]\t${funcName} return ${retVal}`);
        }
    }
    return Interceptor.attach(funcAddr, _hooks);
}
/**
 * typeformat: T.name, where T is: \
 * p: Pointer \
 * i: int \
 * s: String \
 * d%d|%x: data and it's length\
 * v: Pointer => Value \
 * w: Pointer => Pointer => Value \
 * example: traceFunction(null, 'open', 'i.fd', ['s.name', 'p.flag'])
 */
export function traceFunction(
        libnameOrFuncaddr: string | NativePointerValue | null,
        funcName: string,
        retType: string | string[],
        argTypes: string[],
        hooks: ScriptInvocationListenerCallbacks = {}) {
    let funcAddr: NativePointerValue;
    if(libnameOrFuncaddr === null || typeof(libnameOrFuncaddr) == 'string') {
        funcAddr = Module.getExportByName(libnameOrFuncaddr as any, funcName);
    } else {
        funcAddr = libnameOrFuncaddr;
    }
    let fid = 1;
    let _hooks: InvocationListenerCallbacks = {
        onEnter: function (args) {
            this.tid = Process.getCurrentThreadId();
            this.args = [];
            this.fid = fid;
            fid += 1;
            let argslen = argTypes.length;
            if(retType instanceof Array && retType.length-1 > argslen)
                argslen = retType.length-1;
            for(let i = 0; i < argslen; ++i) {
                this.args.push(args[i]);
            }
            this.caller = symbolName(this.returnAddress);
            let logMsg = `[${this.tid}](${this.fid}): ${funcName}(`;
            const todump: {
                handle: NativePointer,
                name: string
            }[] = [];
            if(argTypes.length > 0) {
                for(let i in argTypes) {
                    let name = argTypes[i];
                    let handle = args[i];
                    if(name[0] == 'd') {
                        logMsg += `${getArgName(name)}=${handle}, `;
                        todump.push({handle, name});
                    } else {
                        logMsg += `${getArgName(name)}=${readNativeArg(handle, name)}, `;
                    }
                }
                logMsg = logMsg.slice(0, -2);
            }
            logMsg += `) \n\t\tCalled by ${this.caller}`;
            for(let i in todump) {
                logMsg += readNativeArg(todump[i].handle, todump[i].name);
            }
            console.log(logMsg);
            if(hooks && hooks.onEnter instanceof Function) {
                hooks.onEnter.call(this, args);
            }
        },
        onLeave: function (retVal) {
            if(hooks && hooks.onLeave instanceof Function) {
                hooks.onLeave.call(this, retVal);
            }
            let logMsg = '';
            if (retType instanceof Array) {
                logMsg += `[${this.tid}](${this.fid}): ${funcName} `;
                logMsg += `returned ${readNativeArg(retVal, retType[0])}.`;
                logMsg += '\nargs on return: \t';
                for(let i = 1; i < retType.length; ++i) {
                    logMsg += `${getArgName(retType[i])}: ${readNativeArg(this.args[i-1], retType[i])}, '`;
                }
                logMsg = logMsg.slice(0, -2);
            }
            else {
                logMsg += `[${this.tid}](${this.fid}): ${funcName} returned ${readNativeArg(retVal, retType)}.`;
            }
            logMsg += '\n';
            
            console.log(logMsg);
        }
    }
    return Interceptor.attach(funcAddr, _hooks);
};
/**
 * https://codeshare.frida.re/@oleavr/read-std-string/
 */
export function readStdString(strHandle: NativePointer) {
    const isTiny = (strHandle.readU8() & 1) === 0;
    if (isTiny) {
        return strHandle.add(1).readUtf8String();
    }
    return strHandle.add(2 * Process.pointerSize).readPointer().readUtf8String();
};

export function cprintf(format: string, args: NativePointer[], vaArgIndex = 1, maxSize = 0x1000) {
    let count = 0;
    for(let i = 0; i < format.length - 1; ++i) {
        if(format[i] === '%') {
            i++;
            if(format[i] !== '%') count++;
        }
    }
    const buffer = Memory.alloc(maxSize);
    const types = ['pointer', 'pointer', 'string'];
    const snprintfArgs = [ buffer, ptr(maxSize), format ];
    for(let i = 0; i < count; ++i) {
        types.push('pointer');
        snprintfArgs.push(args[vaArgIndex + i]);
    }
    const snprintf = makefunction(null, 'snprintf', 'int', types);
    snprintf(...snprintfArgs);
    return buffer.readUtf8String();
};

export function showThreads() {
    let threads = Process.enumerateThreads();
    for(let idx in threads) {
        let t = threads[idx];
        console.log(`[${t.id}:${t.state}] pc:${symbolName(t.context.pc)}`);
    }
}

export function showCpuContext(context: CpuContext) {
    try {
        const inst = Instruction.parse(context.pc);
        console.log(symbolName(context.pc), inst.mnemonic, inst.opStr);
    } catch {
        console.log(symbolName(context.pc), "??");
    }
    let i = 0, regsinfo = "";
    for(const regname of Object.getOwnPropertyNames(context)) {
        let regnum = parseInt(context[regname]).toString(16);
        let padn = Process.pointerSize*2 - regnum.length;
        if(padn > 0) regnum = (new Array(padn + 1)).join('0') + regnum;
        regsinfo += regname + "=" + regnum + "\t";
        if(i%4 === 0) regsinfo += "\n";
        i++;
    }
    console.log(regsinfo);
}

function execHandler(context: CpuContext) {
    send({"type": "scope", "act": "enter"});
    let command: string, result: any;
    showCpuContext(context);
    while(true) {
        let codeRecv = recv("scope", function(message) {
            command = message["code"];
        });
        codeRecv.wait();
        if(command === "c") {
            Stalker.unfollow();
            break;
        }
        if(command === "ni") {
            break;
        }
        try {
            result = eval(command);
            if(typeof result === "object")
                result = JSON.stringify(result, function(key, value) {
                    if (key !== "" && typeof value === "object" && value !== null) {
                            if(value.toString !== undefined) return value.toString();
                            return;
                    }
                    return value;
                }, " ");
        } catch(e) {
            result = e.stack;
        }
        send({"type":"scope", "act":"result", "result":result});
    }
    send({"type":"scope", "act":"quit"});
}
const excludeModules = ['libc.so', 'frida-agent-64.so', 'frida-agent-32.so', 'libadirf.so'];
function setupStalker() {
    while(excludeModules.length > 0) {
        const name = excludeModules.pop();
        const module = Process.findModuleByName(name);
        if(module === null) continue;
        Stalker.exclude(module);
    }
}

export function traceExecByStalkerAt(addr: NativePointer) {
    setupStalker();
    Interceptor.attach(addr, function() {
        let startTrace = false;
        Stalker.follow(Process.getCurrentThreadId(), {
            transform: function(iterator) {
                let inst = iterator.next();
                if(addr.equals(inst.address)) startTrace = true;
                while(inst !== null) {
                    if(startTrace) iterator.putCallout(execHandler);
                    iterator.keep();
                    inst = iterator.next();
                }
            }
        });
    });
}



export function showNativeExecption() {
    Process.setExceptionHandler(function(details) {
        if(details.memory) { 
            console.log(details.type, details.memory.operation, details.memory.address, "at", details.address);
        }
        else {
            console.log(details.type, "at", details.address);
        } 
        showCpuContext(details.context);
    });
}